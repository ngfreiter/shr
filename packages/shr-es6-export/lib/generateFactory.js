const CodeWriter = require('./CodeWriter');
const { factoryName } = require('./common.js');

/**
 * Generates a top-level factory class for instantiating ES6 classes based on element type and entry data.
 * @param {Array<NamespaceSpecification>} namespaces - The namespaces to leverage in the factory.
 * @returns {string} The ES6 factory class definition as a string (to be persisted to a .js file).
 */
function generateFactory(namespaces) {
  const cw = new CodeWriter();
  cw.ln(`import { getNamespaceAndName } from './json-helper';`);
  for (const ns of namespaces) {
    const factory = factoryName(ns.namespace);
    cw.ln(`import ${factory} from './${ns.namespace.split('.').join('/')}/${factory}';`);
  }
  cw.ln();

  // Generate the factory
  cw.blComment(`Generated top-level object factory for SHR classes.`)
    .bl('export default class ObjectFactory', () => {
      cw.blComment(() => {
        cw.ln('Create an instance of a class from its JSON representation.')
          .ln('@param {Object} json - The element data in JSON format (use `{}` and provide `type` for a blank instance)')
          .ln(`@param {string} [type] - The (optional) type of the element (e.g., 'http://standardhealthrecord.org/spec/shr/demographics/PersonOfRecord').  This is only used if the type cannot be extracted from the JSON.`)
          .ln('@returns {Object} An instance of the requested class populated with the provided data');
      })
        .bl('static createInstance(json, type)', () => {
          cw.ln('const { namespace } = getNamespaceAndName(json, type);')
            .ln('switch (namespace) {');
          for (const ns of namespaces) {
            const factory = factoryName(ns.namespace);
            cw.ln(`case '${ns.namespace}': return ${factory}.createInstance(json, type);`);
          }
          cw.ln(`default: throw new Error(\`Unsupported namespace: \${namespace}\`);`)
            .ln('}');

        });
    });

  return cw.toString();
}

module.exports = generateFactory;