/*
 * Copyright 2018. F5 Networks, Inc. See End User License Agreement ("EULA") for
 * license terms. Notwithstanding anything to the contrary in the EULA, Licensee
 * may copy and modify this software product for its internal business purposes.
 * Further, Licensee may upload, publish and distribute the modified version of
 * the software product on devcentral.f5.com.
 */

'use strict';

const mustache = require('mustache');

const constants = require('./constants.js');
const util = require('./util.js');
const normalize = require('./normalize.js');
const properties = require('./config/properties.json');
const paths = require('./config/paths.json');
const logger = require('./logger.js');

const pStats = properties.stats;
const context = properties.context;

const CONDITIONAL_FUNCS = {
    deviceVersionGreaterOrEqual
};

/**
 * Endpoint Loader class
 *
 * @param {Object}  options              - initialization options
 * @param {String}  [options.host]       - host to connect to, will override default host
 * @param {Integer} [options.port]       - host's port to connect to, will override default port
 * @param {String}  [options.username]   - username for auth, will override default username
 * @param {String}  [options.passphrase] - passphrase for auth, will override default passphrase
 */
function EndpointLoader(options) {
    this.host = options.host || constants.LOCAL_HOST;
    this.username = options.username || '';
    this.passphrase = options.passphrase || '';
    this.port = options.port || constants.DEFAULT_PORT;
    this.token = null;
    this.endpoints = null;
    this.cachedResponse = {};
}
/**
 * Set endpoints definition
 *
 * @param {Array} newEndpoints - list of endpoints to add
 */
EndpointLoader.prototype.setEndpoints = function (newEndpoints) {
    this.endpoints = {};
    newEndpoints.forEach((endpoint) => {
        // if 'name' presented then use it as unique ID
        // otherwise using 'endpoint' prop
        this.endpoints[endpoint.name || endpoint.endpoint] = endpoint;
    });
};
/**
 * Authenticate on target device
 *
 * @returns {Object} Promise which is resolved when successfully authenticated
 */
EndpointLoader.prototype.auth = function () {
    let promise;
    // if host is localhost we do not need an auth token
    if (this.host === constants.LOCAL_HOST) {
        promise = Promise.resolve({ token: null });
    } else {
        if (!this.username || !this.passphrase) {
            throw new Error('Username and passphrase required');
        }
        promise = util.getAuthToken(this.host, this.username, this.passphrase, { port: this.port });
    }
    return promise.then((token) => {
        this.token = token.token;
    })
        .catch((err) => {
            throw err;
        });
};
/**
 * Notify data listeners
 *
 * @param {String} endpoint    - endpoint name/key
 * @param {Object | null} data - response object or null
 * @param {Error  | null} err  - Error or null
 *
 * @returns (Object) Promise resolved when all listeners were notified
 */
EndpointLoader.prototype._executeCallbacks = function (endpoint, data, err) {
    const callbacks = this.cachedResponse[endpoint][1];
    const promises = [];

    while (callbacks.length) {
        const callback = callbacks.pop();
        promises.push(new Promise((resolve) => {
            callback(data, err);
            resolve();
        }));
    }
    return Promise.all(promises);
};
/**
 * Load data from endpoint
 *
 * @param {String} endpoint            - endpoint name/key to fetch data from
 * @param {Function(Object, Error)} cb - callback function
 */
EndpointLoader.prototype.loadEndpoint = function (endpoint, cb) {
    // eslint-disable-next-line no-unused-vars
    const p = new Promise((resolve, reject) => {
        if (this.endpoints[endpoint] === undefined) {
            reject(new Error(`Endpoint not defined in file: ${endpoint}`));
        } else {
            let dataIsEmpty = false;
            if (this.cachedResponse[endpoint] === undefined) {
                // [loaded, callbacks, data]
                this.cachedResponse[endpoint] = [false, [cb], null];
                dataIsEmpty = true;
            } else {
                this.cachedResponse[endpoint][1].push(cb);
            }
            resolve(dataIsEmpty);
        }
    })
        .then((dataIsEmpty) => {
            if (dataIsEmpty) {
                return this._getAndExpandData(this.endpoints[endpoint])
                    .then((response) => {
                        // cache results
                        this.cachedResponse[endpoint][2] = response;
                        this.cachedResponse[endpoint][0] = true;
                    });
            }
            return Promise.resolve();
        })
        // 1) resolving nested promise with 'reject' to skip follwing 'then'
        // 2) catch HTTP error here to differentiate it from other errors
        .catch(err => this._executeCallbacks(endpoint, null, err)
            .then(Promise.reject()))

        .then(() => {
            if (this.cachedResponse[endpoint][0]) {
                const data = this.cachedResponse[endpoint][2];
                return this._executeCallbacks(endpoint, data, null);
            }
            return Promise.resolve();
        })
        .catch((err) => {
            // error could be empty if Promise was rejected without args.
            if (err) {
                logger.exception(`Error: EndpointLoader.loadEndpoint: ${err}`, err);
            }
        });
};
/**
 * Get data for specific endpoint
 *
 * @param {String} uri             - uri where data resides
 * @param {Object} options         - function options
 * @param {String} [options.name]  - name of key to store as, will override default of uri
 * @param {String} [options.body]  - body to send, sent via POST request
 *
 * @returns {Object} Promise which is resolved with data
 */
EndpointLoader.prototype._getData = function (uri, options) {
    const httpOptions = {
        port: this.port
    };
    if (this.token) {
        httpOptions.headers = {
            'x-f5-auth-token': this.token,
            'User-Agent': constants.USER_AGENT
        };
    }
    if (options.body) {
        httpOptions.method = 'POST';
        httpOptions.body = options.body;
    }

    return Promise.resolve(util.makeRequest(this.host, uri, httpOptions))
        .then((data) => {
            // use uri unless name is explicitly provided
            const nameToUse = options.name !== undefined ? options.name : uri;
            const ret = { name: nameToUse, data };
            return ret;
        })
        .catch((err) => {
            throw err;
        });
};
/**
 * Get data for specific endpoint (with some extra logic)
 *
 * @param {Object} endpointProperties - endpoint properties
 *
 * @returns {Object} Promise which is resolved with data
 */
EndpointLoader.prototype._getAndExpandData = function (endpointProperties) {
    const p = endpointProperties;
    let rawDataToModify;
    let referenceKey;
    const childItemKey = 'items';

    return Promise.resolve(this._getData(p.endpoint, { name: p.name, body: p.body }))
        .then((data) => {
            // data is { name: foo, data: bar }
            // check if expandReferences is requested
            if (p.expandReferences) {
                const actualData = data.data;
                // for now let's just support a single reference
                referenceKey = Object.keys(p.expandReferences)[0];
                const referenceObj = p.expandReferences[Object.keys(p.expandReferences)[0]];

                const promises = [];
                // assumes we are looking inside of single property, might need to extend this to 'entries', etc.
                if (typeof actualData === 'object' && actualData[childItemKey] !== undefined && Array.isArray(actualData[childItemKey])) {
                    for (let i = 0; i < actualData[childItemKey].length; i += 1) {
                        const item = actualData[childItemKey][i];
                        // first check for reference and then link property
                        if (item[referenceKey] && item[referenceKey].link) {
                            // remove protocol/host from self link
                            let referenceEndpoint = item[referenceKey].link.replace('https://localhost', '');
                            if (referenceObj.endpointSuffix) {
                                referenceEndpoint = referenceEndpoint.split('?')[0]; // simple avoidance of query params
                                referenceEndpoint = `${referenceEndpoint}${referenceObj.endpointSuffix}`;
                            }
                            promises.push(this._getData(referenceEndpoint, { name: i }));
                        }
                    }
                }
                rawDataToModify = data; // retain raw data for later use
                return Promise.all(promises);
            }
            // default is to just return the data
            return Promise.resolve(data);
        })
        .then((data) => {
            // this tells us we need to modify the raw data, or at least attempt to do so
            if (rawDataToModify) {
                data.forEach((i) => {
                    // try/catch, default should be to just continue
                    try {
                        rawDataToModify.data[childItemKey][i.name][referenceKey] = i.data;
                    } catch (e) {
                        // continue
                    }
                });
                return Promise.resolve(rawDataToModify);
            }
            // again default is to just return the data
            return Promise.resolve(data);
        })
        .catch((err) => {
            throw err;
        });
};


/**
 * System Stats Class
 */
function SystemStats() {
    this.loader = null;
    this.contextData = {};
    this.collectedData = {};
}
/**
 * Split key
 *
 * @param {String} key - key to split
 *
 * @returns {Object} Return data formatted like { rootKey: 'key, childKey: 'key' }
 */
SystemStats.prototype._splitKey = function (key) {
    const splitKeys = key.split(constants.STATS_KEY_SEP);
    const rootKey = splitKeys[0];
    // remove root key from splitKeys
    splitKeys.shift();
    const childKey = splitKeys.length > 0 ? splitKeys.join(constants.STATS_KEY_SEP) : undefined;
    return { rootKey, childKey };
};
/**
 * Evaluate conditional block
 *
 * @param {Object} conditionalBlock - block to evaluate, where object's key - conditional opertor
 *                                    object's value - params for that operator
 *
 * @returns {boolean} conditional result
 */
SystemStats.prototype._resolveConditional = function (conditionalBlock) {
    let ret = true;
    Object.keys(conditionalBlock).forEach((key) => {
        const func = CONDITIONAL_FUNCS[key];
        if (func === undefined) {
            throw new Error(`Unknown property in conditional block ${key}`);
        }
        ret = ret && func(this.contextData, conditionalBlock[key]);
    });
    return ret;
};
/**
 * Property pre-processing to resolve conditionals
 *
 * @param {Object} property - property object
 *
 * @returns {Object} pre-processed deep copy of property object
 */
SystemStats.prototype._preprocessProperty = function (property) {
    if (property.if) {
        const newObj = {};
        // property can result in 'false' when
        // 'else' or 'then' were not defined.
        while (property) {
            // copy all non-conditional data on same level to new object
            // eslint-disable-next-line
            Object.keys(property).forEach((key) => {
                if (!(key === 'if' || key === 'then' || key === 'else')) {
                    newObj[key] = property[key];
                }
            });
            // so, we copied everything we needed.
            // break in case there is no nested 'if' block
            if (!property.if) {
                break;
            }
            // trying to resolve conditional
            property = this._resolveConditional(property.if)
                ? property.then : property.else;
        }
        property = newObj;
    }
    // deep copy
    return JSON.parse(JSON.stringify(property));
};
/**
 * Render key using mustache template system
 *
 * @param {Object} property - property object
 *
 * @returns {Object} rendered property object
 */
SystemStats.prototype._renderProperty = function (property) {
    // should be easy to add support for more complex templates like {{ #something }}
    // but not sure we are really need it now.
    // For now just supporting simple templates which
    // generates single string only
    if (property.key) property.key = mustache.render(property.key, this.contextData);
    return property;
};
/**
 * Process loaded data
 *
 * @param {Object} property - property object
 * @param {Object} data     - data object
 *
 * @returns {Object} normalized data (if needed)
 */
SystemStats.prototype._processData = function (property, data) {
    const options = {
        key: this._splitKey(property.key).childKey,
        filterByKeys: property.filterKeys,
        renameKeysByPattern: property.renameKeys,
        convertArrayToMap: property.convertArrayToMap,
        runCustomFunction: property.runFunction
    };
    return property.normalize === false ? data : normalize.data(data, options);
};
/**
 * Load data for property
 *
 * @param {Object} property     - property object
 * @param {String} property.key - key to identify endpoint to load data from
 * @returns {Object} Promise resolved with fetched data object
 */
SystemStats.prototype._loadData = function (property) {
    return new Promise((resolve, reject) => {
        const endpoint = this._splitKey(property.key).rootKey;
        this.loader.loadEndpoint(endpoint, (data, err) => {
            if (err) {
                reject(err);
            } else {
                resolve(data.data);
            }
        });
    });
};
/**
 * Process property
 *
 * @param {String} key      - key to store collected data
 * @param {Object} property - property object
 *
 * @returns {Object} Promise resolved when data was successfully colleted
 */
SystemStats.prototype._processProperty = function (key, property) {
    return new Promise((resolve, reject) => {
        property = this._renderProperty(this._preprocessProperty(property));
        /**
         * if endpoints will have their own 'disabled' flag
         * we will need to add additional check here or simply return empty value.
         * An Empty value will result in 'missing key' after normalization.
         */
        if (property.disabled) {
            resolve();
        } else {
            this._loadData(property)
                .then(data => Promise.resolve(this._processData(property, data)))
                .then((data) => {
                    this.collectedData[key] = data;
                })
                .then(resolve)
                .catch(reject);
        }
    })
        .catch((err) => {
            logger.error(`Error: SystemStats._processProperty: ${key} (${property.key}): ${err}`);
            return Promise.reject(err);
        });
};
/**
 * Process context object
 *
 * @param {Object} contextData         - context object to load
 * @param {String} contextData.<key>   - key to store loaded data
 * @param {Object} contextData.<value> - property object to use to load data
 *
 * @returns {Object} Promise resolved when all context's properties were loaded
 */
SystemStats.prototype._processContext = function (contextData) {
    const promises = Object.keys(contextData)
        .map(key => this._processProperty(key, contextData[key]));

    return Promise.all(promises).then(() => {
        Object.assign(this.contextData, this.collectedData);
        this.collectedData = {};
    });
};
/**
 * Compute all contextual data
 *
 * @param {Object | Array} contextData - context object(s) to load
 *
 * @returns (Object) Promise resolved when contextual data were loaded
 */
SystemStats.prototype._computeContextData = function (contextData) {
    let promise;

    if (Array.isArray(contextData)) {
        if (contextData.length) {
            promise = this._processContext(contextData[0]);
            // eslint-disable-next-line no-plusplus
            for (let i = 1; i < contextData.length; i++) {
                promise.then(this._processContext(contextData[i]));
            }
        }
    } else if (contextData) {
        promise = this._processContext(contextData);
    }
    if (!promise) {
        promise = Promise.resolve();
    }
    return promise;
};
/**
 * Compute properties
 *
 * @param {Object} propertiesData - object with properties
 *
 * @returns {Object} Promise resolved when all properties were loaded
 */
SystemStats.prototype._computePropertiesData = function (propertiesData) {
    return Promise.all(Object.keys(propertiesData)
        .map(key => this._processProperty(key, propertiesData[key])));
};
/**
 * Collect info based on object provided in properties
 *
 * @param {String}  host       - host
 * @param {Integer} port       - port
 * @param {String}  username   - username for host
 * @param {String}  passphrase - password for host
 *
 * @returns {Object} Promise which is resolved with a map of stats
 */
SystemStats.prototype.collect = function (host, port, username, passphrase, otherPropsToInject) {
    this.loader = new EndpointLoader({
        host, port, username, passphrase
    });
    this.loader.setEndpoints(paths.endpoints);
    return this.loader.auth()
        .then(() => this._computeContextData(context))
        .then(() => this._computePropertiesData(pStats))
        .then(() => {
            const orderedData = {};
            Object.keys(pStats).forEach((key) => {
                orderedData[key] = this.collectedData[key];
            });
            return Promise.resolve(orderedData);
        })
        .then((data) => {
            // inject service data
            const serviceProps = {};
            if (otherPropsToInject) {
                Object.assign(serviceProps, otherPropsToInject);
            }
            data.telemetryServiceInfo = serviceProps;
            return Promise.resolve(data);
        });
};

/**
 * Comparison functions
 */

/**
 * Compare version strings
 *
 * @param {String} version1   - version to compare
 * @param {String} comparator - comparison operator
 * @param {String} version2   - version to compare
 *
 * @returns {boolean} true or false
 */
function compareVersionStrings(version1, comparator, version2) {
    comparator = comparator === '=' ? '==' : comparator;
    if (['==', '===', '<', '<=', '>', '>=', '!=', '!=='].indexOf(comparator) === -1) {
        throw new Error(`Invalid comparator '${comparator}'`);
    }
    const v1parts = version1.split('.');
    const v2parts = version2.split('.');
    const maxLen = Math.max(v1parts.length, v2parts.length);
    let part1;
    let part2;
    let cmp = 0;
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < maxLen && !cmp; i++) {
        part1 = parseInt(v1parts[i], 10) || 0;
        part2 = parseInt(v2parts[i], 10) || 0;
        if (part1 < part2) {
            cmp = 1;
        } else if (part1 > part2) {
            cmp = -1;
        }
    }
    // eslint-disable-next-line no-eval
    return eval(`0${comparator}${cmp}`);
}
/**
 * Compare device versions
 *
 * @param {Object} contextData               - context data
 * @param {Object} contextData.deviceVersion - device's version to compare
 * @param {String} versionToCompare          - version to compare against
 *
 * @returns {boolean} true when device's version is greater or equal
 */
function deviceVersionGreaterOrEqual(contextData, versionToCompare) {
    const deviceVersion = contextData.deviceVersion;
    if (deviceVersion === undefined) {
        throw new Error('deviceVersionGreaterOrEqual: context has no property \'deviceVersion\'');
    }
    return compareVersionStrings(deviceVersion, '>=', versionToCompare);
}


module.exports = SystemStats;
