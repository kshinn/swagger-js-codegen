'use strict';

var fs = require('fs');
var Mustache = require('mustache');
var beautify = require('js-beautify').js_beautify;
var lint = require('jshint').JSHINT;
var _ = require('lodash');

var camelCase = function(id) {
    if(id.indexOf('-') === -1) {
        return id;
    }
    var tokens = [];
    id.split('-').forEach(function(token, index){
        if(index === 0) {
            tokens.push(token[0].toLowerCase() + token.substring(1));
        } else {
            tokens.push(token[0].toUpperCase() + token.substring(1));
        }
    });
    return tokens.join('');
};

var normalizeName = function(id) {
    return id.replace(/\.|\-|\{|\}/g, '_');
};

var getPathToMethodName = function(m, path){
    if(path === '/' || path === '') {
        return m;
    }

    // clean url path for requests ending with '/'
    var cleanPath = path;
    if( cleanPath.indexOf('/', cleanPath.length - 1) !== -1 ) {
        cleanPath = cleanPath.substring(0, cleanPath.length - 1);
    }

    var segments = cleanPath.split('/').slice(1);
    segments = _.transform(segments, function (result, segment) {
        if (segment[0] === '{' && segment[segment.length - 1] === '}') {
            segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
        }
        result.push(segment);
    });
    var result = camelCase(segments.join('-'));
    return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

var resolveType = function() {
    var type;
    var items;
    var ref;

    if (this.schema !== undefined) {
        type = this.schema.type;
        items = this.schema.items;
        ref = (items === undefined) ? this.schema.$ref : items.$ref;
    } else if (this.type !== undefined) {
        type = this.type;
        if (this.type === 'array') {
            items = this.items;
            ref = this.$ref || items.$ref;
        }
    }

    if (type === 'array') {
        if (this.items !== undefined) {
            console.log(this.items);
        }
        if (ref) {
            if (ref.indexOf('#') === 0) {
                var parts = ref.split(/#/g, ref);
                return parts.pop() + '[]';
            }
            return ref + '[]';
        }
        return '[]';
    }
    else {
        return type;
    }
};

var resolveResponse = function() {
    var type;
    var ref;

    if (this.schema !== undefined) {
        type = this.schema.type;
    } else {
        return '{}';
    }

    if (type === 'array') {
        if (this.schema.items !== undefined) {
            ref = this.schema.items.$ref;
        } else {
            ref = this.schema.$ref;
        }
        return 'Array<' + ref + '>';
    }

    // Todo: better parsing of embedded objects
    if (type === 'object') {
        return 'any';
    }

    if (this.schema.$ref !== undefined) {
        return this.schema.$ref;
    } else {
        return 'unknown'; // probably should raise an error
    }

};

var getViewForSwagger2 = function(opts, type){
    var swagger = opts.swagger;
    var authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLIK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
    var data = {
        isNode: type === 'node',
        description: swagger.info.description,
        isSecure: swagger.securityDefinitions !== undefined,
        moduleName: opts.moduleName,
        className: opts.className,
        domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath) ? swagger.schemes[0] + '://' + swagger.host + swagger.basePath : '',
        methods: [],
        dataTypes: []
    };

    _.forEach(swagger.paths, function(api, path){
        var globalParams = [];
        /**
         * @param {Object} op - meta data for the request
         * @param {string} m - HTTP method name - eg: 'get', 'post', 'put', 'delete'
         */
        _.forEach(api, function(op, m){
            if(m.toLowerCase() === 'parameters') {
                globalParams = op;
            }
        });

        _.forEach(api, function(op, m){
            if(authorizedMethods.indexOf(m.toUpperCase()) === -1) {
                return;
            }
            var method = {
                path: path,
                className: opts.className,
                methodName: op['x-swagger-js-method-name'] ? op['x-swagger-js-method-name'] : (op.operationId ? normalizeName(op.operationId) : getPathToMethodName(m, path)),
                method: m.toUpperCase(),
                isGET: m.toUpperCase() === 'GET',
                summary: op.description,
                isSecure: swagger.security !== undefined || op.security !== undefined,
                parameters: [],
            };
            var params = [];
            if(_.isArray(op.parameters)) {
                params = op.parameters;
            }
            params = params.concat(globalParams);
            _.forEach(params, function(parameter) {
                // Ignore headers which are injected by proxies & app servers
                // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
                if (parameter['x-proxy-header'] && !data.isNode) {
                    return;
                }
                if (_.isString(parameter.$ref)) {
                    var segments = parameter.$ref.split('/');
                    parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2] ];
                }
                parameter.camelCaseName = camelCase(parameter.name);
                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.in === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.in === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.in === 'query'){
                    if(parameter['x-name-pattern']){
                        parameter.isPatternType = true;
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.in === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.in === 'formData'){
                    parameter.isFormParameter = true;
                }
                method.parameters.push(parameter);
            });

            // Find the successful response
            var successResponse = {};
            _.forEach(['200', '201', '204', 'default'], function(code) {
                if (op.responses[code] !== undefined) {
                    if (code === 'default') {
                        successResponse.isDefault = true;
                    }
                    successResponse.schema = op.responses[code].schema;
                    successResponse.statusCode = code;
                    successResponse.resolveType = _.bind(resolveResponse, successResponse);

                    return false;
                }
            });
            method.response = successResponse;

            data.methods.push(method);
        });
    });

    _.forEach(swagger.definitions, function(def, name) {
        var cls = {
            name: name,
        };

        _.mapValues(def.properties, function(val, key) {
            val.name = key;
        });

        // Transform to an array to make Mustache happy
        cls.properties = _.values(def.properties);
        _.map(cls.properties, function(prop) {
            prop.resolveType = resolveType;
        });
        data.dataTypes.push(cls);
    });

    console.log(data);
    return data;
};

var getViewForSwagger1 = function(opts, type){
    var swagger = opts.swagger;
    var data = {
        isNode: type === 'node',
        description: swagger.description,
        moduleName: opts.moduleName,
        className: opts.className,
        domain: swagger.basePath ? swagger.basePath : '',
        methods: []
    };
    swagger.apis.forEach(function(api){
        api.operations.forEach(function(op){
            var method = {
                path: api.path,
                className: opts.className,
                methodName: op.nickname,
                method: op.method,
                isGET: op.method === 'GET',
                summary: op.summary,
                parameters: op.parameters
            };
            op.parameters = op.parameters ? op.parameters : [];
            op.parameters.forEach(function(parameter) {
                parameter.camelCaseName = camelCase(parameter.name);
                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.paramType === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.paramType === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.paramType === 'query'){
                    if(parameter.pattern){
                        parameter.isPatternType = true;
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.paramType === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.paramType === 'form'){
                    parameter.isFormParameter = true;
                }
            });
            data.methods.push(method);
        });
    });
    return data;
};

var getCode = function(opts, type) {
    // For Swagger Specification version 2.0 value of field 'swagger' must be a string '2.0'
    var data = opts.swagger.swagger === '2.0' ? getViewForSwagger2(opts, type) : getViewForSwagger1(opts, type);
    opts.template = _.isObject(opts.template) ? opts.template : {};

    if (type === 'custom') {
        if (!_.isString(opts.template.class)  || !_.isString(opts.template.method) || !_.isString(opts.template.request)) {
            throw new Error('Unprovided custom template. Please use the following template: template: { class: "...", method: "...", request: "..." }');
        }
    } else {
        var templates = __dirname + '/../templates/';
        opts.template.class = opts.template.class || fs.readFileSync(templates + type + '-class.mustache', 'utf-8');
        opts.template.method = opts.template.method || fs.readFileSync(templates + 'method.mustache', 'utf-8');
        opts.template.request = opts.template.request || fs.readFileSync(templates + type + '-request.mustache', 'utf-8');
    }

    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }

    var source = Mustache.render(opts.template.class, data, opts.template);
    var lintOptions = {
        node: type === 'node' || type === 'custom',
        browser: type === 'angular' || type === 'custom',
        undef: true,
        strict: true,
        trailing: true,
        smarttabs: true,
        maxerr: 999
    };
    if (opts.esnext) {
        lintOptions.esnext = true;
    }

    if (opts.lint === undefined || opts.lint === true) {
        lint(source, lintOptions);
        lint.errors.forEach(function(error) {
            if (error.code[0] === 'E') {
                throw new Error(error.reason + ' in ' + error.evidence + ' (' + error.code + ')');
            }
        });
    }
    if (opts.beautify === undefined || opts.beautify === true) {
        return beautify(source, { indent_size: 4, max_preserve_newlines: 2 });
    } else {
        return source;
    }
};

var getInterfaces = function(opts, type) {
    // This is for statically typed languages such as TypeScript or Go that would require
    // the struct / interface definitions.
    var data = opts.swagger.swagger === '2.0' ? getViewForSwagger2(opts, type) : getViewForSwagger1(opts, type);
    opts.template = _.isObject(opts.template) ? opts.template : {};

    if (type === 'custom') {
        if (!_.isString(opts.template.interface)) {
            throw new Error('Unprovided custom interface template. Please define an interface template');
        }
    } else {
        var templates = __dirname + '/../templates/';
        opts.template.interface = opts.template.interface || fs.readFileSync(templates + type + '-interface.mustache', 'utf-8');
    }

    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }

    var source = {};
    _.forEach(data.dataTypes, function(dt) {
        source[dt.name] = Mustache.render(opts.template.interface, dt, opts.template);
    });
    return source;
};


exports.CodeGen = {
    getAngularCode: function(opts){
        return getCode(opts, 'angular');
    },
    getNodeCode: function(opts){
        return getCode(opts, 'node');
    },
    getAngularTsCode: function(opts){
        var files = {};
        files[opts.className] = getCode(opts, 'angularTs');
        _.assign(files, getInterfaces(opts, 'angularTs'));

        return files;
    },
    getCustomCode: function(opts){
        return getCode(opts, 'custom');
    }
};
