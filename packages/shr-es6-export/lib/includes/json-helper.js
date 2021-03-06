import Reference from './Reference';
import { ALL_KNOWN_VALUE_SETS } from './valueSets';
import Concept from './Concept';
import Coding from './Coding';

// A variable to hold the root ObjectFactory.  This can be set via the exported setObjectFactory function,
// but should typically be set by importing the module's init file.
var OBJECT_FACTORY;

// Regular expressions for parsing URIs and FQNs
const URI_REGEX = /^http:\/\/standardhealthrecord\.org\/spec\/(.*)\/([^/]+)$/;

/**
 * Sets the root ObjectFactory, which is needed for proper recursive creation of instances
 * @param {ObjectFactory} factory - the root ObjectFactory used to create instances
 */
export function setObjectFactory(factory) {
  OBJECT_FACTORY = factory;
}

/**
 * Parses the JSON and/or type to return an object with the namespace and elementName.
 * @param {Object} json - The element data in JSON format (use `{}` and provide `type` for a blank instance)
 * @param {string} [type] - The (optional) type of the element (e.g., 'http://standardhealthrecord.org/spec/shr/base/Patient' or 'shr.base.Patient').  This is only used if the type cannot be extracted from the JSON.
 * @returns {{namespace: string, elementName: string}} An object representing the element
 */
export function getNamespaceAndName(json={}, type) {
  // Get the type from the JSON if we can
  if (json['EntryType']) {
    type = json['EntryType'].Value;
  }
  // Ensure we have a type before proceeding
  if (!type) {
    throw new Error(`Couldn't find type for JSON: ${JSON.stringify(json)}`);
  } else if (type === 'EntryType') {
    return { namespace: 'shr.base', elementName: 'EntryType' };
  }
  // Try to match on a URI
  const uriMatch = type.match(URI_REGEX);
  if (uriMatch) {
    const namespace = uriMatch[1].split('/').join('.');
    const elementName = uriMatch[2];
    return { namespace, elementName };
  } else if (type.indexOf('.') !== -1) {
    // assume it's of the form namespace.ClassName
    const lastDot = type.lastIndexOf('.');
    const namespace = type.slice(0, lastDot);
    const elementName = type.slice(lastDot + 1); // don't include the dot
    return { namespace, elementName };
  }
  // No match, so throw an error
  throw new Error(`Illegal element type: ${type}`);
}

/**
 * Parses the JSON and/or type to return an object with the namespace and elementName.
 * @param {Object} fhir - The element data in FHIR JSON format
 * @param {string} [type] - The (optional) type of the element (e.g., a profile URL 'http://example.com/fhir/StructureDefinition/cimi-entity-Patient' or a fully qualified type name 'cimi.entity.Patient').  This is only used if the type cannot be extracted from the JSON.
 * @returns {{namespace: string, elementName: string}} An object representing the element
 */
export function getNamespaceAndNameFromFHIR(fhir, type) {
  // Special case for primitives
  if (typeof fhir !== 'object') {
    if (type == null) {
      return { namespace: 'primitive', elementName: typeof fhir };
    } else if (type.indexOf('.') === -1) {
      return { namespace: 'primitive', elementName: type };
    }
  }
  // Get the type from the JSON if we can
  if (fhir['meta'] && fhir['meta']['profile']) {
    type = fhir['meta']['profile'][0];
  }
  // Ensure we have a type before proceeding
  if (!type) {
    throw new Error(`Couldn't find type for FHIR: ${JSON.stringify(fhir)}`);
  }

  if (type.includes('/')) {
    // assume it's a profile URI, where the last part represents the type
    const parts = type.split('/');
    type = parts[parts.length - 1].replace(/-/g, '.');
  }

  const mappingStringArray = type.split('.');
  const elementName = mappingStringArray.pop();
  const namespace = mappingStringArray.join('.');
  return { namespace, elementName };
}


/**
 * Given a (presumably) blank instance of an ES6 class representing an element, and JSON that adheres to the
 * corresponding JSON schema for that element, this function will loop through the JSON and set the applicable
 * properties on the class instance.  If the JSON contains any properties that can't be found or set in the class,
 * an error will be sent to the console.
 * @param {object} inst - an instance of an ES6 class for a specific element
 * @param {object} json - a JSON object containing the date to set in the class
 */
export function setPropertiesFromJSON(inst, json) {
  // Loop through each key in the JSON, attempting to set it as a property on the class
  for (const key of Object.keys(json)) {
    // The key has a captialized name (e.g., Bar), but the property is a lowercased version of the element name (e.g., bar)
    const property = lowerCaseFirst(key);
    // First try to find and set it directly on the instance
    const setter = findSetterForProperty(inst, property);
    if (setter) {
      setter.call(inst, createInstance(key, json[key]));
    }
    // Then, if it's an instance property, set it on the embedded entryInfo.
    const setterOnEntry = findSetterForEntryProperty(inst, property);
    if (setterOnEntry) {
      setterOnEntry.call(inst.entryInfo, createInstance(key, json[key]));
    }
    // If we didn't find a match directly or on entryInfo, spit an error to the console.  The exception is for
    // shr.base.EntryType, which is used to indicate the field's type in the JSON, but not necessarily always a
    // settable property in the class.
    if (!setter && !setterOnEntry && key !== 'EntryType') {
      console.error(`${inst.constructor.name}: No setter for '${property}' property`);
    }
  }
}

/**
 * Given an instance of a class and a property name, finds the setter function for that property (if it exists).
 * @param {object} inst - an instance of a class
 * @param {string} property - the name of a property
 * @returns {function} a function used to set the property on the instance
 */
function findSetterForProperty(inst, property) {
  // Get the prototype, as we need this to detect if properties exist and are settable
  const proto = Object.getPrototypeOf(inst);
  if (!proto || proto.constructor.name === 'Object') {
    return undefined;
  }
  // The property descriptor provides information about the property on the class (if it exists)
  const pd = Object.getOwnPropertyDescriptor(proto, property);
  // If the property exists, return its setter (which will be undefined if it's not settable)
  if (pd) {
    return pd.set;
  }
  // It didn't exist on this prototype, but may be from a superclass
  return findSetterForProperty(proto, property);
}

/**
 * Given an instance of a class and a valid entry property name, finds the setter function for that property in the
 * class's `entryInfo` (if the class have `entryInfo` and the property exists within it).
 * @param {object} inst - An instance of a class
 * @param {string} property - The name of a property
 * @returns {function} a function used to set the property on the instance's `entryInfo`
 */
function findSetterForEntryProperty(inst, property) {
  // First see if there is a settable entryInfo on the class.  If not, return undefined.
  const entryInfoSetter = findSetterForProperty(inst, 'entryInfo');
  if (entryInfoSetter) {
    // Now see if there is an existing entryInfo, and if not, set it to a new instance
    if (typeof inst.entryInfo === 'undefined') {
      const newEntry = createInstance('shr.base.Entry', {});
      entryInfoSetter.call(inst, newEntry);
    }
    // Now find the setter for the property on the entry
    return findSetterForProperty(inst.entryInfo, property);
  }
  // If we got here, it wasn't found, so we're returning undefined
}

/**
 * Creates an ES6 class instance based on a value extracted from the JSON.
 * @param {string} key - the original key under which the value was stored.  This is used as a backup in case the value
 *   does not declare its type.
 * @param {object} value - the JSON data to create an ES6 class instance for
 * @returns {object} an instance of an ES6 class representing the data
 * @private
 */
function createInstance(key, value) {
  if (Array.isArray(value)) {
    return value.map(v => createInstance(key, v));
  }
  if (typeof value === 'object') {
    if (value._ShrId && value._EntryId && value._EntryType) {
      // It's a reference, so just return the reference
      return new Reference(value._ShrId, value._EntryId, value._EntryType);
    } else if (value.EntryType == null && Array.isArray(value.coding)) {
      // It's a concept, so return an instance of Concept
      return new Concept(value.coding.map(c => new Coding(c.code, c.system, c.display)));
    }
    if (OBJECT_FACTORY == null) {
      throw new Error(`SHR ES6 module is not initialized.  Import 'init' before using the ES6 factories and classes`);
    }
    return OBJECT_FACTORY.createInstance(value, key);
  }
  return value;
}

/**
 * Wrapper object to contain multiple functions, so that generated classes don't have to pre-determine which functions to specifically import.
 */
export const FHIRHelper = {

  /**
   * Creates an ES6 class instance based on a value extracted from the JSON.
   * @param {string} shrType - the fqn of the class to be instantiated
   * @param {object} fhir - the FHIR data to create an ES6 class instance for
   * @param {string} fhirType - the type of the FHIR object passed in, just in case it's not otherwise available by inspecting the object
   * @returns {object} an instance of an ES6 class representing the data
   * @private
   */
  createInstanceFromFHIR: function(shrType, fhir, fhirType, shrId, allEntries=[], mappedResources={}, referencesOut=[], asExtension=false) {
    if (Array.isArray(fhir)) {
      return fhir.map(v => FHIRHelper.createInstanceFromFHIR(shrType, v, fhirType, shrId, allEntries, mappedResources, referencesOut, asExtension));
    }
    if (OBJECT_FACTORY == null) {
      throw new Error(`SHR ES6 module is not initialized.  Import 'init' before using the ES6 factories and classes`);
    }
    return OBJECT_FACTORY.createInstanceFromFHIR(shrType, fhir, fhirType, shrId, allEntries, mappedResources, referencesOut, asExtension);
  },

  /**
   * Given an SHR object, return a Reference that points to that object, and add the object to the given list.
   *
   * @param {Object} shrObject - the SHR object to reference
   * @param {List<Object>} referenceList - the list of objects that are referenced
   * @returns {Reference} the reference
   */
  createReference: function(shrObject, referenceList=[]) {
    if (!shrObject) {
      return null;
    }

    const ref = new Reference(shrObject.entryInfo.shrId, shrObject.entryInfo.entryId, shrObject.entryInfo.entryType);
    ref.reference = shrObject;
    referenceList.push(shrObject);
    return ref;
  },

  /**
   * Returns a reference to an SHR entry
   * @param {string} shrId - the SHR ID for the thing being referenced
   * @param {string} entryId - the Entry ID for the thing being referenced
   * @param {string} entryType - the entry type for the thing being referenced
   * @returns {Reference} the reference
   */
  createReferenceWithoutObject: function(shrId, entryId, entryType) {
    return new Reference(
      createInstance('shr.base.ShrId', { Value: shrId }),
      createInstance('shr.base.EntryId', { Value: entryId }),
      createInstance('shr.base.EntryType', { Value: entryType })
    );
  },

  /**
   * Creates and SHR Concept from a FHIR code, Coding, or CodeableConcept
   *
   * @param {string|Object} fhir - the FHIR code, Coding, or CodeableConcept
   * @returns {Concept} the corresponding SHR Concept instance
   */
  createConcept: function(fhir) {
    if (fhir == null) {
      return fhir;
    } else if (typeof fhir === 'string') {
      // create Concept from FHIR code
      return new Concept().withCoding([new Coding().withCode(fhir)]);
    } else if (fhir && (fhir.code || fhir.system || fhir.display)) {
      // create Concept from FHIR Coding
      return new Concept().withCoding([new Coding(fhir.code, fhir.system, fhir.display)]);
    } else if (fhir && (fhir.coding || fhir.text)) {
      const concept = new Concept();
      if (fhir.coding) {
        concept.coding = fhir.coding.map(c => new Coding(c.code, c.system, c.display));
      }
      return concept;
    }
  },

  /**
   * Determines if a resource in a FHIR entry conforms to a specific profile.  Conformance is only checked by
   * inspecting the instance's meta.profile field.
   * @param {Object} fhirEntry - a FHIR entry object (with fullUrl and resource keys)
   * @param {string} targetProfile - the URL of the target profile
   * @returns {boolean} true if the entry's resource conforms, false otherwise
   */
  conformsToProfile: function(fhirEntry = {}, targetProfile = '') {
    return fhirEntry.resource && fhirEntry.resource.meta && fhirEntry.resource.meta.profile && fhirEntry.resource.meta.profile.some(p => p === targetProfile);
  },

  /**
   * Look up the valueset in the map of all known value sets.
   * See valueSets.js for the actual generated map, and shr-es6-export/lib/export.js for how the map is built up.
   */
  valueSet: function(url) {
    return ALL_KNOWN_VALUE_SETS[url] || [];
  }
};

/**
 * Generate a random v4 UUID.
 */
export function uuid() {
  // source: https://stackoverflow.com/a/2117523
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Returns the input string with its first letter lowercased
 * @param {string} input - the string to lowercase the first letter for
 * @returns {string} a new string representing the input string with a lowercased first letter
 * @private
 */
function lowerCaseFirst(input) {
  if (!input || input.length === 0) {
    return input;
  }
  return input[0].toLowerCase() + input.slice(1);
}
