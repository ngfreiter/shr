const bunyan = require('bunyan');
const {FileStream, CommonTokenStream} = require('antlr4/index');
const {SHRDataElementLexer} = require('./parsers/SHRDataElementLexer');
const {SHRDataElementParser} = require('./parsers/SHRDataElementParser');
const {SHRDataElementParserVisitor} = require('./parsers/SHRDataElementParserVisitor');
const {Version} = require('shr-models');

const VERSION = new Version(6, 0, 0);
const GRAMMAR_VERSION = new Version(6, 0, 0);

var rootLogger = bunyan.createLogger({name: 'shr-text-import'});
var logger = rootLogger;

function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}

class Preprocessor extends SHRDataElementParserVisitor {
  constructor(configuration=[]) {
    super();
    // The preprocessed data
    this._data = new PreprocessedData();
    this._config = configuration;
  }

  get data() { return this._data; }

  preprocessConfig(defaultsFile, file) {

    var defaults = JSON.parse(defaultsFile);
    var configFile = {};

    if (file != null) {
      try { configFile = JSON.parse(new FileStream(file)); }
      catch (e) {
        logger.error('Invalid config file. Should be valid JSON dictionary. ERROR_CODE:11006');
        return defaults;
      }
    } else {
      logger.warn(`No project configuration file found, currently using default EXAMPLE identifiers. Auto-generating a proper 'config.json' in your specifications folder. ERROR_CODE:01001`);
      return defaults;
    }

    // Fix config where necessary
    // [1] Translate old IG fields to new IG fields
    const checkIgProperty = (oldPropertyName, igPropertyName) => {
      if (configFile[oldPropertyName] != null) {
        logger.warn(`Configuration file '${oldPropertyName}' field will be deprecated. Use 'implementationGuide.${igPropertyName}' instead.`);
        configFile.implementationGuide = configFile.implementationGuide || {};
        configFile.implementationGuide[igPropertyName] = configFile[oldPropertyName];
        delete configFile[oldPropertyName];
      }
    };
    checkIgProperty('igIndexContent', 'indexContent');
    checkIgProperty('igLogicalModels', 'includeLogicalModels');
    checkIgProperty('igModelDoc', 'includeModelDoc');
    checkIgProperty('igPrimarySelectionStrategy', 'primarySelectionStrategy');
    // [2] Remove trailing slashes from projectURL and fhirURL
    for (let key of ['projectURL', 'fhirURL']) {
      if (configFile[key] && configFile[key].endsWith('/')) {
        configFile[key] = configFile[key].slice(0, -1);
      }
    }
    // [3] Create fhirURL from projectURL if necessary
    if (configFile.fhirURL == null && configFile.projectURL != null) {
      configFile.fhirURL = `${configFile['projectURL']}/fhir`;
    }
    // [4] Fill in default data where it is missing
    fillInDefaultData(defaults, configFile);

    this._config = configFile;

    return configFile;
  }

  preprocessFile(file) {
    // Setup a child logger to associate logs with the current file
    const lastLogger = logger;
    logger = rootLogger.child({ file: file });
    logger.debug('Start preprocessing data elements file');
    try {
      const chars = new FileStream(file);
      const lexer = new SHRDataElementLexer(chars);
      lexer.removeErrorListeners(); // Only log errors during the import
      const tokens  = new CommonTokenStream(lexer);
      const parser = new SHRDataElementParser(tokens);
      parser.removeErrorListeners(); // Only log errors during the import
      parser.buildParseTrees = true;
      const tree = parser.doc();
      this.visitDoc(tree);
    } finally {
      logger.debug('Done preprocessing data elements file');
      this.logger = lastLogger;
    }
  }

  visitDoc(ctx) {
    if (ctx.docHeader().version()) {
      if (!this.checkVersion(ctx.docHeader().version())) {
        return;
      }
    }
    let ns = '';
    if(ctx.docHeader().namespace()) {
      ns = ctx.docHeader().namespace().getText();
      logger.debug({shrId: ns}, 'Start preprocessing namespace');
    }
    try {
      if (ctx.pathDefs()) {
        const removeTrailingSlash = function(url) {
          while (url.endsWith('/')) { url = url.substring(0, url.length - 1); }
          return url;
        };
        for (const def of ctx.pathDefs().pathDef()) {
          const name = def.ALL_CAPS().getText();
          let url = removeTrailingSlash(def.URL().getText());
          while (url.endsWith('/')) {
            url = url.substring(0, url.length - 1);
          }
          this._data.registerPath(ns, name, url);
        }
      }
      if (ctx.vocabularyDefs()) {
        for (const def of ctx.vocabularyDefs().vocabularyDef()) {
          const name = def.ALL_CAPS().getText();
          var url;
          if (def.URL()) {
            url = def.URL().getText();
          } else if (def.URN_OID()) {
            url = def.URN_OID().getText();
          } else if (def.URN()) {
            url = def.URN().getText();
          }
          this._data.registerVocabulary(ns, name, url);
        }
      }
      for (const def of ctx.dataDefs().dataDef()) {
        if (def.entryDef()) {
          const name = def.entryDef().entryHeader().simpleName().getText();
          this._data.registerDefinition(ns, name, 'entry');
        } else if (def.elementDef()) {
          const name = def.elementDef().elementHeader().simpleName().getText();
          this._data.registerDefinition(ns, name, 'element');
        } else if (def.abstractDef()) {
          const name = def.abstractDef().abstractHeader().simpleName().getText();
          this._data.registerDefinition(ns, name, 'abstract');
        } else if (def.groupDef()) {
          const name = def.groupDef().groupHeader().simpleName().getText();
          this._data.registerDefinition(ns, name, 'group');
        }
      }
    } finally {
      logger.debug({shrId: ns}, 'Done preprocessing namespace');
    }
  }

  checkVersion(version) {
    const major = parseInt(version.WHOLE_NUMBER()[0], 10);
    const minor = parseInt(version.WHOLE_NUMBER()[2], 10);
    if (GRAMMAR_VERSION.major != major || GRAMMAR_VERSION.minor < minor) {
      logger.error('Unsupported grammar version: %s.%s. ERROR_CODE:11007', major, minor);
      return false;
    }
    return true;
  }
}

class PreprocessedData {
  constructor() {
    this._paths = {}; //map[namespace]map[name]url
    this._vocabularies = {}; // map[namespace]map[name]url
    this._definitions = {}; // map[namespace]map[name]type
  }

  registerPath(namespace, name, url) {
    let ns = this._paths[namespace];
    if (typeof ns == 'undefined') {
      ns = {};
      this._paths[namespace] = ns;
    }
    ns[name] = url;
  }

  registerVocabulary(namespace, name, url) {
    let ns = this._vocabularies[namespace];
    if (typeof ns == 'undefined') {
      ns = {};
      this._vocabularies[namespace] = ns;
    }
    ns[name] = url;
  }

  registerDefinition(namespace, name, type) {
    let ns = this._definitions[namespace];
    if (typeof ns == 'undefined') {
      ns = {};
      this._definitions[namespace] = ns;
    }
    ns[name] = type;
  }

  resolvePath(name, ...namespace) {
    // First ensure namespaces were passed in
    if (namespace.length == 0) {
      return { error: `Cannot resolve path without namespaces. ERROR_CODE:11017` };
    }

    // Special handling for default paths
    if (name == 'default') {
      const ns = namespace[0];
      if (this._paths[ns] && this._paths[ns]['default']) {
        return { url: this._paths[ns]['default'] };
      }
      // Didn't find default, so infer default from namespace
      const parts = ns.split('.');
      return this._config.projectURL + '/' + parts.join('/') + '/vs';
    }

    // Attempt to resolve specific path
    const result = {};
    const foundNamespaces = [];
    let conflict = false;
    for (const ns of namespace) {
      if (this._paths[ns] && this._paths[ns][name]) {
        if (!result.hasOwnProperty('url')) {
          result['url'] = this._paths[ns][name];
        } else if (result.url != this._paths[ns][name]) {
          conflict = true;
        }
        foundNamespaces.push(ns);
      }
    }
    if (!result.hasOwnProperty('url')) {
      result['error'] = `Failed to resolve path for ${name}. ERROR_CODE:11018`;
    } else if (conflict) {
      result['error'] = `Found conflicting path for ${name} in multiple namespaces: ${foundNamespaces}. ERROR_CODE:11019`;
    }
    return result;
  }

  resolveVocabulary(name, ...namespace) {
    const result = {};
    const foundNamespaces = [];
    let conflict = false;
    for (const ns of namespace) {
      if (this._vocabularies[ns] && this._vocabularies[ns][name]) {
        if (!result.hasOwnProperty('url')) {
          result['url'] = this._vocabularies[ns][name];
        } else if (result.url != this._vocabularies[ns][name]) {
          conflict = true;
        }
        foundNamespaces.push(ns);
      }
    }
    if (!result.hasOwnProperty('url')) {
      result['error'] = `Failed to resolve vocabulary for ${name}. ERROR_CODE:11020`;
    } else if (conflict) {
      result['error'] = `Found conflicting vocabularies for ${name} in multiple namespaces: ${foundNamespaces}. ERROR_CODE:11021`;
    }
    return result;
  }

  resolveDefinition(name, ...namespace) {
    const result = {};
    const foundNamespaces = [];
    for (const ns of namespace) {
      if (this._definitions[ns] && this._definitions[ns][name]) {
        if (!result.hasOwnProperty('namespace')) {
          result['namespace'] = ns;
          result['type'] = this._definitions[ns][name];
        }
        foundNamespaces.push(ns);
      }
    }
    if (!result.hasOwnProperty('namespace')) {
      result['error'] = `Failed to resolve definition for ${name}. ERROR_CODE:11013`;
    } else if (foundNamespaces.length > 1) {
      result['error'] = `Found conflicting definitions for ${name} in multiple namespaces: ${foundNamespaces}. ERROR_CODE:11022`;
    }
    return result;
  }
}

function fillInDefaultData(defaultData, configData, parentKeys = []) {
  //Fill in config dictionary with default values, if necessary (with some special logic)
  for (let key in defaultData) {
    if (typeof defaultData[key] === 'object' && configData[key] != null) {
      // Need to drill in further to see if subkeys are missing
      fillInDefaultData(defaultData[key], configData[key], [...parentKeys, key]);
    } else if (configData[key] == null) {
      configData[key] = defaultData[key];
      logger.warn('Configuration file missing key: %s, using default value: %s. ERROR_CODE:01002', [...parentKeys, key].join('.'), JSON.stringify(configData[key]));
    }
  }
}

module.exports = { Preprocessor, PreprocessedData, VERSION, GRAMMAR_VERSION, setLogger };
