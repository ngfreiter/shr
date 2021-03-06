// export SHR specification content as a hierarchy in JSON format
// Author: John Gibson
// Derived from export SHR specification content as a hierarchy in JSON format by Greg Quinn

const bunyan = require('bunyan');
const {Identifier, IdentifiableValue, ChoiceValue, TBD, IncompleteValue, ValueSetConstraint, IncludesCodeConstraint, IncludesTypeConstraint, CodeConstraint, CardConstraint, TypeConstraint, INHERITED, OVERRIDDEN, BooleanConstraint, FixedValueConstraint, MODELS_INFO, PRIMITIVE_NS} = require('shr-models');
const builtinSchema = require('./schemas/cimpl.builtin.schema.json');

var rootLogger = bunyan.createLogger({name: 'shr-json-schema-export'});
var logger = rootLogger;
function setLogger(bunyanLogger) {
  rootLogger = logger = bunyanLogger;
}


/**
 * Converts a group of specifications into JSON Schema.
 * @param {Specifications} expSpecifications - a fully expanded Specifications object.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the EntryType field.
 * @param {boolean=} flat - if true then the generated schema will not be hierarchical. Defaults to false.
 * @return {Object.<string, Object>} A mapping of schema ids to JSON Schema definitions.
 */
function exportToJSONSchema(expSpecifications, baseSchemaURL, baseTypeURL, flat = false) {
  const namespaceResults = {
    'https://standardhealthrecord.org/schema/cimpl/builtin': builtinSchema
  };
  const endOfTypeURL = baseTypeURL[baseTypeURL.length - 1];
  if (endOfTypeURL !== '#' && endOfTypeURL !== '/') {
    baseTypeURL += '/';
  }
  for (const ns of expSpecifications.namespaces.all) {
    const lastLogger = logger;
    logger = logger.child({ shrId: ns.namespace});
    try {
      logger.debug('Exporting namespace.');
      if (flat) {
        const { schemaId, schema } = flatNamespaceToSchema(ns, expSpecifications.dataElements, baseSchemaURL, baseTypeURL);
        namespaceResults[schemaId] = schema;
      } else {
        const { schemaId, schema } = namespaceToSchema(ns, expSpecifications.dataElements, baseSchemaURL, baseTypeURL);
        namespaceResults[schemaId] = schema;
      }
      logger.debug('Finished exporting namespace.');
    } finally {
      logger = lastLogger;
    }
  }

  return namespaceResults;
}

/**
 * Converts a namespace into a JSON Schema.
 * @param {Namespace} ns - the namespace of the schema.
 * @param {DataElementSpecifications} dataElementsSpecs - the elements in the namespace.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the EntryType field.
 * @return {{schemaId: string, schema: Object}} The schema id and the JSON Schema definition.
 */
function namespaceToSchema(ns, dataElementsSpecs, baseSchemaURL, baseTypeURL) {
  const dataElements = dataElementsSpecs.byNamespace(ns.namespace);
  const schemaId = `${baseSchemaURL}/${namespaceToURLPathSegment(ns.namespace)}`;
  let schema = {
    $schema: 'http://json-schema.org/draft-04/schema#',
    id: schemaId,
    title: 'TODO: Figure out what the title should be.',
    definitions: {}
  };
  const entryRef = makeRef(new Identifier('shr.base', 'Entry'), ns, baseSchemaURL);
  if (ns.description) {
    schema.description = ns.description;
  }
  const nonEntryEntryTypeField = {
    $ref: makeRef(new Identifier('shr.base', 'EntryType'), ns, baseSchemaURL)
  };

  const defs = dataElements.sort(function(l,r) {return l.identifier.name.localeCompare(r.identifier.name);});
  const entryRefs = [];
  for (const def of defs) {
    const lastLogger = logger;
    logger = logger.child({ shrId: def.identifier.fqn});
    try {
      logger.debug('Exporting element');
      let schemaDef = {
        type: 'object',
        properties: {}
      };
      let wholeDef = schemaDef;
      const tbdParentDescriptions = [];
      let requiredProperties = [];
      let needsEntryType = false;
      if (def.isEntry || def.basedOn.length) {
        wholeDef = { allOf: [] };
        let hasEntryParent = false;
        for (const supertypeId of def.basedOn) {
          if (supertypeId instanceof TBD) {
            if (supertypeId.text) {
              tbdParentDescriptions.push(supertypeId.text);
            } else {
              tbdParentDescriptions.push('TBD');
            }
          } else {
            const parent = dataElementsSpecs.findByIdentifier(supertypeId);
            if (!parent) {
              logger.error('Could not find definition for %s which is a supertype of %s', supertypeId, def);
            } else {
              hasEntryParent = hasEntryParent || parent.isEntry;
            }
            wholeDef.allOf.push({ $ref: makeRef(supertypeId, ns, baseSchemaURL)});
          }
        }
        if (def.isEntry && (!hasEntryParent)) {
          wholeDef.allOf.splice(0, 0, { $ref: entryRef });
        }
        wholeDef.allOf.push(schemaDef);
      } else {
        needsEntryType = true;
      }

      const tbdFieldDescriptions = [];
      if (def.value) {
        if (def.value.inheritance !== INHERITED) {
          let { value, required, tbd } = convertDefinition(def.value, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
          if (required) {
            requiredProperties.push('Value');
          }
          schemaDef.properties.Value = value;
          if (tbd) {
            schemaDef.properties.Value.description = def.value.text ? ('TBD: ' + def.value.text) : tbdValueToString(def.value);
          }
        }
      }
      if (def.fields.length) {
        const fieldNameMap = {};
        const clashingNames = {};
        for (const field of def.fields) {
          if (!(field instanceof TBD)) {
            if (!isValidField(field)) {
              continue;
            } else if (field.inheritance === INHERITED) {
              if (fieldNameMap[field.identifier.name]) {
                logger.error(`ERROR: clashing property names: %s and %s ERROR_CODE: 12038`, fieldNameMap[field.identifier.name].fqn, field.identifier.fqn);
                clashingNames[field.identifier.name] = true;
              } else {
                fieldNameMap[field.identifier.name] = field.identifier;
              }
              continue;
            }

            if (fieldNameMap[field.identifier.name]) {
              logger.error(`ERROR: clashing property names: %s and %s ERROR_CODE: 12038`, fieldNameMap[field.identifier.name].fqn, field.identifier.fqn);
              clashingNames[field.identifier.name] = true;
              continue;
            } else {
              fieldNameMap[field.identifier.name] = field.identifier;
            }
          }
          const card = field.effectiveCard;
          if (card && card.isZeroedOut) {
            continue;
          }
          let {value, required, tbd} = convertDefinition(field, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
          if (tbd) {
            tbdFieldDescriptions.push(tbdValueToString(field));
            continue;
          }

          if (field.identifier.fqn === 'shr.base.EntryType') {
            needsEntryType = false;
          }

          schemaDef.properties[field.identifier.name] = value;
          if (required) {
            requiredProperties.push(field.identifier.name);
          }
        }

        for (const clashingName in clashingNames) {
          delete schemaDef.properties[clashingName];
        }
        requiredProperties = requiredProperties.filter(propName => !(propName in clashingNames));
      } else if (!def.value) {
        schemaDef.type = 'object';
        schemaDef.description = 'Empty DataElement?';
      }
      let descriptionList = [];
      if (def.description) {
        descriptionList.push(def.description);
      }
      if (def.concepts.length) {
        wholeDef.concepts = def.concepts.map((concept) => makeConceptEntry(concept));
      }
      if (tbdParentDescriptions.length) {
        tbdParentDescriptions[0] = 'TBD Parents: ' + tbdParentDescriptions[0];
        descriptionList = descriptionList.concat(tbdParentDescriptions);
      }
      if (tbdFieldDescriptions.length) {
        tbdFieldDescriptions[0] = 'TBD Fields: ' + tbdFieldDescriptions[0];
        descriptionList = descriptionList.concat(tbdFieldDescriptions);
      }
      if (descriptionList.length) {
        wholeDef.description = descriptionList.join('\n');
      }
      if (needsEntryType) {
        schemaDef.properties['EntryType'] = nonEntryEntryTypeField;
        if (def.identifier.fqn !== 'shr.base.EntryType') {
          requiredProperties.push('EntryType');
        }
      }

      if (requiredProperties.length) {
        schemaDef.required = requiredProperties;
      }

      schema.definitions[def.identifier.name] = wholeDef;
      if (def.isEntry && (!def.isAbstract)) {
        entryRefs.push({ $ref: makeRef(def.identifier, ns, baseSchemaURL)});
      }
    } finally {
      logger = lastLogger;
    }
  }

  if (entryRefs.length) {
    schema.type = 'object';
    schema.anyOf = entryRefs;
  }
  return { schemaId, schema };
}

/**
 * Converts a namespace into a flat JSON Schema.
 * @param {Namespace} ns - the namespace of the schema.
 * @param {DataElementSpecifications} dataElementsSpecs - the elements in the namespace.
 * @param {string} baseSchemaURL - the root URL for the schema identifier.
 * @param {string} baseTypeURL - the root URL for the EntryType field.
 * @return {{schemaId: string, schema: Object}} The schema id and the JSON Schema definition.
 */
function flatNamespaceToSchema(ns, dataElementsSpecs, baseSchemaURL, baseTypeURL) {
  const dataElements = dataElementsSpecs.byNamespace(ns.namespace);
  const schemaId = `${baseSchemaURL}/${namespaceToURLPathSegment(ns.namespace)}`;
  let schema = {
    $schema: 'http://json-schema.org/draft-04/schema#',
    id: schemaId,
    title: 'TODO: Figure out what the title should be.',
    definitions: {}
  };
  const expandedEntry = makeExpandedEntryDefinitions(ns, baseSchemaURL);
  if (ns.description) {
    schema.description = ns.description;
  }

  const defs = dataElements.sort(function(l,r) {return l.identifier.name.localeCompare(r.identifier.name);});
  const entryRefs = [];
  for (const def of defs) {
    let schemaDef = {
      type: 'object',
      properties: {}
    };
    let wholeDef = schemaDef;
    const tbdParentDescriptions = [];
    let requiredProperties = [];
    if (def.isEntry) {
      requiredProperties = expandedEntry.required.slice();
    }

    const tbdFieldDescriptions = [];
    if (def.value) {
      let { value, required, tbd } = convertDefinition(def.value, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
      if (required) {
        requiredProperties.push('Value');
      }
      schemaDef.properties.Value = value;
      if (tbd) {
        schemaDef.properties.Value.description = def.value.text ? ('TBD: ' + def.value.text) : tbdValueToString(def.value);
      }
    }
    if (def.fields.length) {
      for (const field of def.fields) {
        if (!(field instanceof TBD) && !isValidField(field)) {
          continue;
        }
        const card = field.effectiveCard;
        if (card && card.isZeroedOut) {
          continue;
        }
        let {value, required, tbd} = convertDefinition(field, dataElementsSpecs, ns, baseSchemaURL, baseTypeURL);
        if (tbd) {
          tbdFieldDescriptions.push(tbdValueToString(field));
          continue;
        }

        const fieldName = field.identifier.name;
        schemaDef.properties[fieldName] = value;
        if (required && (requiredProperties.indexOf(fieldName) === -1)) {
          requiredProperties.push(fieldName);
        }
      }
      if (def.isEntry) {
        for (const name in expandedEntry.properties) {
          if (!(name in schemaDef.properties)) {
            schemaDef.properties[name] = expandedEntry.properties[name];
          }
        }
      }
    } else if (!def.value) {
      schemaDef.type = 'object';
      schemaDef.description = 'Empty DataElement?';
    }
    let descriptionList = [];
    if (def.description) {
      descriptionList.push(def.description);
    }
    if (def.concepts.length) {
      wholeDef.concepts = def.concepts.map((concept) => makeConceptEntry(concept));
    }
    if (tbdParentDescriptions.length) {
      tbdParentDescriptions[0] = 'TBD Parents: ' + tbdParentDescriptions[0];
      descriptionList = descriptionList.concat(tbdParentDescriptions);
    }
    if (tbdFieldDescriptions.length) {
      tbdFieldDescriptions[0] = 'TBD Fields: ' + tbdFieldDescriptions[0];
      descriptionList = descriptionList.concat(tbdFieldDescriptions);
    }
    if (descriptionList.length) {
      wholeDef.description = descriptionList.join('\n');
    }
    if (requiredProperties.length) {
      schemaDef.required = requiredProperties;
    }

    schema.definitions[def.identifier.name] = wholeDef;
    if (def.isEntry && (!def.isAbstract)) {
      entryRefs.push({ $ref:  makeRef(def.identifier, ns, baseSchemaURL)});
    }
  }

  if (entryRefs.length) {
    schema.type = 'object';
    schema.anyOf = entryRefs;
  }
  return { schemaId, schema };
}

function namespaceToURLPathSegment(namespace) {
  return namespace.replace(/\./g, '/');
}

function isValidField(field) {
  if (field instanceof ChoiceValue) {
    logger.error('Ignoring field defined as a choice', field.toString());
    return false;
  }
  if (!(field.identifier)) {
    logger.error('Ignoring name-less field: ', field.toString());
    return false;
  }
  if (field.identifier.name === 'Value') {
    logger.error('Ignoring restricted field name: Value', field.toString());
    return false;
  }
  return true;
}

function convertDefinition(valueDef, dataElementsSpecs, enclosingNamespace, baseSchemaURL, baseTypeURL) {
  let listValue = null;
  let value = {};
  const fullDef = valueDef.identifier ? dataElementsSpecs.findByIdentifier(valueDef.identifier) : null;
  const card = valueDef.effectiveCard;
  let required = false;
  let isList = false;
  let valueIsPrimitive = false;
  if (card) {
    isList = card.isList;
    if (!isList && fullDef && fullDef.value) {
      const cardConstraints = fullDef.value.constraintsFilter.own.card.constraints;
      isList = cardConstraints.some((oneCard) => oneCard.isList);
    }
    if (isList) {
      listValue = { type: 'array' };
      if (card.min != null) {
        listValue.minItems = card.min;
        if (card.min) {
          required = true;
        }
      }
      if (card.max) {
        listValue.maxItems = card.max;
      }
      listValue.items = value;
    } else if (card.min) {
      required = true;
    }
  }

  if (valueDef instanceof ChoiceValue) {
    const refOptions = [];
    const normalOptions = [];
    for (const option of valueDef.options) {
      if (option.effectiveCard && (!option.effectiveCard.isExactlyOne)) {
        logger.error('Choices with options with cardinalities that are not exactly one are illegal "%s". Ignoring option %s.', valueDef.toString(), option.toString());
      } else if (isRef(option, dataElementsSpecs)) {
        refOptions.push(option);
      } else {
        normalOptions.push(option);
      }
    }
    value.anyOf = [];
    if (refOptions.length) {
      value.anyOf.push(makeShrRefObject(refOptions, baseTypeURL));
    }
    for (const option of normalOptions) {
      const { value: childValue } = convertDefinition(option, dataElementsSpecs, enclosingNamespace, baseSchemaURL, baseTypeURL);
      value.anyOf.push(childValue);
    }
    if (value.anyOf.length == 1) {
      const single = value.anyOf[0];
      delete value.anyOf;
      for (const ent in single) {
        value[ent] = single[ent];
      }
    }
  } else if (isRef(valueDef, dataElementsSpecs)) {
    // TODO: What should the value of EntryType be? The schema URL may not be portable across data types.
    makeShrRefObject([valueDef], baseTypeURL, value);
  } else if (valueDef instanceof IdentifiableValue) {
    const id = valueDef.effectiveIdentifier;
    if (id.isPrimitive) {
      valueIsPrimitive = true;
      makePrimitiveObject(id, value);
    } else {
      const typeRef = makeRef(valueDef.identifier, enclosingNamespace, baseSchemaURL);
      if (valueDef.inheritance !== OVERRIDDEN) {
        value.allOf = [{ $ref: typeRef}];
      }
    }
  } else if (valueDef instanceof TBD) {
    let ret = value;
    if (listValue) {
      delete listValue.items;
      ret = listValue;
    }
    return {value: ret, required: required, tbd: true};
  } else if (valueDef instanceof IncompleteValue) {
    logger.error('Unsupported Incomplete');
  } else {
    logger.error('Unknown type for value "%s"', valueDef.constructor.name);
  }

  const constraintStructure = { $self: []};
  const includesCodeLists = {};
  for (const constraint of valueDef.constraints) {
    let {path: constraintPath, target: constraintTarget } = extractConstraintPath(constraint, valueDef, dataElementsSpecs);
    if (!constraintPath) {
      continue;
    } else if (!constraintTarget) {
      // Cardinality constraints without a path are not useful (except if you're really a list, we'll handle that later).
      if (constraint instanceof CardConstraint) {
        continue;
      } else {
        constraintTarget = valueDef;
      }
    }

    let currentStruct = constraintStructure;
    for (const path of constraintPath) {
      if (!currentStruct[path]) {
        currentStruct[path] = { $self: []};
      }
      currentStruct = currentStruct[path];
    }
    currentStruct.$self.push({ constraint, constraintPath, constraintTarget });
  }

  let allOf = [{properties: {}}];
  if (Object.keys(value).length) {
    allOf.push(value);
  }
  function pruneExpandedStructure (currentAllOf) {
    for (let i = currentAllOf.length - 1; i >= 0; i -= 1) {
      const allOfEntry = currentAllOf[i];
      if (allOfEntry.constraints && (!allOfEntry.constraints.length)) {
        delete allOfEntry.constraints;
      }
      if (allOfEntry.properties) {
        if (!Object.keys(allOfEntry.properties).length) {
          delete allOfEntry.properties;
        } else {
          for (const path in allOfEntry.properties) {
            if (allOfEntry.properties[path].allOf) {
              pruneExpandedStructure(allOfEntry.properties[path].allOf);
              switch (allOfEntry.properties[path].allOf.length) {
              case 1:
                allOfEntry.properties[path] = allOfEntry.properties[path].allOf[0];
                break;
              case 0:
                delete allOfEntry.properties[path].allOf;
                break;
              }
            }
            if (!Object.keys(allOfEntry.properties[path]).length) {
              delete allOfEntry.properties[path];
            }
          }
          if (!Object.keys(allOfEntry.properties).length) {
            delete allOfEntry.properties;
          }
        }
      }
      if (allOfEntry.allOf && allOfEntry.allOf.length === 1) {
        for (const key in allOfEntry.allOf[0]) {
          if (key !== 'allOf') {
            allOfEntry[key] = allOfEntry.allOf[0][key];
          }
        }
        delete allOfEntry.allOf;
      }
      if (!Object.keys(allOfEntry).length) {
        currentAllOf.splice(i, 1);
      }
    }
  }

  function constraintDfs (node, currentAllOf, parentAllOf = null) {
    for (const path in node) {
      if (path !== '$self') {
        if (!currentAllOf[0].properties[path]) {
          currentAllOf[0].properties[path] = {
            allOf: [
              { properties: {} }
            ]
          };
        }
        constraintDfs(node[path], currentAllOf[0].properties[path].allOf, currentAllOf);
      } else {
        currentAllOf[0].constraints = [];
        let includesConstraints = null;
        let includesCodeConstraints = null;
        for (const constraintInfo of node.$self) {
          if (constraintInfo.constraint instanceof TypeConstraint) {
            if (isRef(constraintInfo.constraintTarget, dataElementsSpecs)) {
              const refid = constraintInfo.constraint.isA;
              if (isOrWasAList(constraintInfo.constraintTarget)) {
                currentAllOf.push({ items: { refType: [`${baseTypeURL}${namespaceToURLPathSegment(refid.namespace)}/${refid.name}`]}});
              } else {
                currentAllOf.push({ refType: [`${baseTypeURL}${namespaceToURLPathSegment(refid.namespace)}/${refid.name}`]});
              }
            } else if (constraintInfo.constraintTarget instanceof IdentifiableValue) {
              let schemaConstraint = null;
              if (constraintInfo.constraint.isA.isPrimitive) {
                schemaConstraint = makePrimitiveObject(constraintInfo.constraint.isA);
              } else {
                schemaConstraint = {$ref: makeRef(constraintInfo.constraint.isA, enclosingNamespace, baseSchemaURL)};
              }
              if (isOrWasAList(constraintInfo.constraintTarget)) {
                currentAllOf.push({ items: schemaConstraint });
              } else {
                currentAllOf.push(schemaConstraint);
              }
            } else {
              logger.error('Internal error unexpected constraint target: %s for constraint %s', constraintInfo.constraintTarget.toString(), constraintInfo.constraint.toString());
            }
          } else if (constraintInfo.constraint instanceof IncludesTypeConstraint) {
            if (!includesConstraints) {
              includesConstraints = {refs: [], types: [], min: 0, max: 0};
            }
            includesConstraints.min += constraintInfo.constraint.card.min;
            if (includesConstraints.max !== null) {
              if (constraintInfo.constraint.card.isMaxUnbounded) {
                includesConstraints.max = null;
              } else {
                includesConstraints.max += constraintInfo.constraint.card.max;
              }
            }

            if (isRef(constraintInfo.constraint.isA, dataElementsSpecs)) {
              includesConstraints.refs.push(constraintInfo.constraint);
            } else {
              includesConstraints.types.push(constraintInfo.constraint);
            }
          } else if (constraintInfo.constraint instanceof IncludesCodeConstraint) {
            if (!includesCodeConstraints) {
              includesCodeConstraints = [];
            }
            includesCodeConstraints.push(constraintInfo.constraint);
          } else if (constraintInfo.constraint instanceof ValueSetConstraint) {
            if (currentAllOf[0].valueSet) {
              logger.error(`Multiple valueset constraints found on a single element %s.`, constraintInfo.constraint);
              continue;
            }
            currentAllOf[0].valueSet = {
              uri: constraintInfo.constraint.valueSet,
              strength: constraintInfo.constraint.bindingStrength
            };
          } else if (constraintInfo.constraint instanceof CodeConstraint) {
            // Maybe TODO: For entry elements this can have some level of enforcement by ANDing the exact contents of the EntryType field with an enum for this value/field.
            if (currentAllOf[0].code) {
              logger.error(`Multiple code constraints found on a single element %s.`, constraintInfo.constraint);
              continue;
            }
            currentAllOf[0].code = makeCodingEntry(constraintInfo.constraint.code);
          } else if (constraintInfo.constraint instanceof BooleanConstraint) {
            currentAllOf.push({ enum: [constraintInfo.constraint.value]});
          } else if (constraintInfo.constraint instanceof FixedValueConstraint) {
            currentAllOf.push({ enum: [constraintInfo.constraint.value]});
          } else if (constraintInfo.constraint instanceof CardConstraint) {
            // TODO: 0..0
            if (isOrWasAList(constraintInfo.constraintTarget)) {
              const arrayDef = {
                type: 'array',
                minItems: constraintInfo.constraint.card.min,
              };
              if (constraintInfo.constraint.card.max) {
                arrayDef.maxItems = constraintInfo.constraint.card.max;
              }
              currentAllOf.push(arrayDef);
              if (parentAllOf && constraintInfo.constraint.card.min) {
                parentAllOf.push({ required: [constraintInfo.constraintPath[constraintInfo.constraintPath.length - 1]] });
              }
            } else {
              if (parentAllOf && constraintInfo.constraint.card.min) {
                parentAllOf.push({ required: [constraintInfo.constraintPath[constraintInfo.constraintPath.length - 1]] });
              }
            }
          } else {
            currentAllOf[0].constraints.push(constraintInfo.constraint);
          }
        }

        if (includesConstraints) {
          currentAllOf[0].includesTypes = [];
          const includesTypesArrayDef = {
            type: 'array',
            minItems: includesConstraints.min,
            items: { anyOf: [] }
          };
          currentAllOf.push(includesTypesArrayDef);
          if (includesConstraints.max !== null) {
            includesTypesArrayDef.maxItems = includesConstraints.max;
          }
          if (includesConstraints.refs.length) {
            includesTypesArrayDef.items.anyOf.push(makeShrRefObject(includesConstraints.refs.map((ref) => ref.isA), baseTypeURL));
            for (const ref of includesConstraints.refs) {
              const includesType = {
                items: `ref(${makeShrDefinitionURL(ref.isA, baseSchemaURL)})`,
                minItems: ref.card.min
              };
              if (!ref.card.isMaxUnbounded) {
                includesType.maxItems = ref.card.max;
              }
              currentAllOf[0].includesTypes.push(includesType);
            }
          }
          for (const val of includesConstraints.types) {
            includesTypesArrayDef.items.anyOf.push({ $ref: makeRef(val.isA, enclosingNamespace, baseSchemaURL) });
            const includesType = {
              items: `${baseTypeURL}${namespaceToURLPathSegment(val.isA.namespace)}/${val.isA.name}`,
              minItems: val.card.min
            };
            if (!val.card.isMaxUnbounded) {
              includesType.maxItems = val.card.max;
            }
            currentAllOf[0].includesTypes.push(includesType);
          }
        }
        if (includesCodeConstraints) {
          currentAllOf[0].includesCodes = includesCodeConstraints.map((it) => makeCodingEntry(it.code));
        }
      }
    }
  }

  if (valueDef.constraints && valueDef.constraints.length) {
    constraintDfs(constraintStructure, allOf);
    if (isList) {
      for (const includesConstraintDef of allOf) {
        if (includesConstraintDef.type === 'array') {
          if ((listValue.minItems !== null) && (listValue.minItems !== undefined)) {
            listValue.minItems = Math.max(listValue.minItems, includesConstraintDef.minItems);
          } else {
            listValue.minItems = includesConstraintDef.minItems;
          }
          // TODO: Support 0..0
          if (listValue.maxItems == null) {
            listValue.maxItems = includesConstraintDef.maxItems;
          } else {
            if (includesConstraintDef.maxItems != null) {
              listValue.maxItems = Math.min( listValue.maxItems, includesConstraintDef.maxItems);
            }
          }
          listValue.includesTypes = allOf[0].includesTypes;
          delete allOf[0].includesTypes;

          allOf.push(includesConstraintDef.items);
          delete includesConstraintDef.items;
          delete includesConstraintDef.maxItems;
          delete includesConstraintDef.minItems;
          delete includesConstraintDef.type;
          break;
        }
      }
    }

    if (valueIsPrimitive) {
      pruneExpandedStructure(allOf);
      if (value !== allOf[0]) {
        for (const prop in allOf[0]) {
          value[prop] = allOf[0][prop];
          delete allOf[0][prop];
        }
      }
    }
  }
  pruneExpandedStructure(allOf);
  function sanityCheckFinalStructure (currentAllOf) {
    for (let i = currentAllOf.length - 1; i >= 0; i -= 1) {
      const allOfEntry = currentAllOf[i];
      if (allOfEntry.constraints) {
        for (const constraint of allOfEntry.constraints) {
          logger.error('Internal error: unhandled constraint %s', constraint.toString());
        }
      }
      if (allOfEntry.properties) {
        for (const path in allOfEntry.properties) {
          if (allOfEntry.properties[path].allOf) {
            sanityCheckFinalStructure(allOfEntry.properties[path].allOf);
          } else {
            sanityCheckFinalStructure([allOfEntry.properties[path]]);
          }
        }
      }
    }
  }
  sanityCheckFinalStructure(allOf);

  if (allOf.length) {
    const allOfDef = allOf.length === 1 ? allOf[0] : { allOf: allOf };
    if (listValue) {
      listValue.items = allOfDef;
    } else {
      value = allOfDef;
    }
  }

  if (Object.keys(includesCodeLists).length) {
    value.codes = includesCodeLists;
  }

  return {value: listValue ? listValue : value, required, tbd: false};
}

function tbdValueToString(tbd) {
  if (tbd.text) {
    return tbd.text;
  } else {
    const card = tbd.effectiveCard;
    if (card) {
      return 'TBD with cardinality ' + card;
    } else {
      return 'TBD';
    }
  }
}

function isRef(value, dataElementsSpecs) {
  if (value && value.effectiveIdentifier) {
    const de = dataElementsSpecs.findByIdentifier(value.effectiveIdentifier);
    return de && de.isEntry;
  }
  return false;
}

/**
 * Create a JSON Schema reference to the specified type.
 *
 * @param {Identifier} id - the target type.
 * @param {Namespace} enclosingNamespace - the current namespace that is being evaluated.
 * @param {string} baseSchemaURL - the root URL for the schema identifier
 * @returns {string} - a JSON Schema reference to the target type.
 */
function makeRef(id, enclosingNamespace, baseSchemaURL) {
  if (id.namespace === enclosingNamespace.namespace) {
    return '#/definitions/' + id.name;
  } else {
    return makeShrDefinitionURL(id, baseSchemaURL);
  }
}

function makeShrRefObject(refs, baseTypeURL, target = {}) {
  target.type = 'object';
  target.properties = {
    _ShrId: { type: 'string' },
    _EntryId: { type: 'string' },
    _EntryType: { type: 'string' }
  };
  target.required = ['_ShrId', '_EntryType', '_EntryId'];
  target.refType = refs.map((ref) => `${baseTypeURL}${namespaceToURLPathSegment(ref.identifier.namespace)}/${ref.identifier.name}`);
  return target;
}

function makeShrDefinitionURL(id, baseSchemaURL) {
  return `${baseSchemaURL}/${namespaceToURLPathSegment(id.namespace)}#/definitions/${id.name}`;
}

function makePrimitiveObject(id, target = {}) {
  switch (id.name) {
  case 'boolean':
  case 'string':
  case 'integer':
    target.type = id.name;
    break;
  case 'unsignedInt':
    target.type = 'integer';
    target.minimum = 0;
    break;
  case 'positiveInt':
    target.type = 'integer';
    target.minimum = 1;
    break;
  case 'decimal':
    target.type = 'number';
    break;
  case 'uri':
    target.type = 'string';
    target.format = 'uri';
    break;
  case 'base64Binary':
    target.type = 'string';
    break;
  case 'dateTime':
    target.type = 'string';
    target.format = 'date-time';
    break;
  case 'instant':
  case 'date':
  case 'time':
    target.type = 'string';
    break;
  case 'concept':
    target['$ref'] = 'https://standardhealthrecord.org/schema/cimpl/builtin#/definitions/Concept';
    break;
  case 'oid':
  case 'id':
  case 'markdown':
  case 'xhtml':
    target.type = 'string';
    break;
  }

  return target;
}

/**
 * Translates a constraint path into a valid path for the JSON Schema.
 * @param {Constraint} constraint - the constraint.
 * @param {IdentifiableValue} valueDef - the identifiable value that contains the constraint.
 * @param {DataElementSpecifications} dataElementSpecs - the elements in the namespace.
 * @return {{path: (Array<string>|undefined), target: (Value|undefined)}} - The target of the constraint and the extracted path (qualified if necessary). Both properties will be null if there was an error.
 */
function extractConstraintPath(constraint, valueDef, dataElementSpecs) {
  if (constraint.onValue) {
    return extractUnnormalizedConstraintPath(constraint, valueDef, dataElementSpecs);
  } else if (constraint.path.length > 0 && constraint.path[constraint.path.length-1].isValueKeyWord) {
    // Essentially the same as above, when onValue is never checked again, so just chop it off
    // treat it like above.  TODO: Determine if this is really the right approach.
    const simpleConstraint = constraint.clone();
    simpleConstraint.path = simpleConstraint.path.slice(0, simpleConstraint.path.length-1);
    return extractUnnormalizedConstraintPath(simpleConstraint, valueDef, dataElementSpecs);
  }

  if (!constraint.hasPath()) {
    return { path: [] };
  }

  let currentDef = dataElementSpecs.findByIdentifier(valueDef.effectiveIdentifier);
  const normalizedPath = [];
  let target = null;
  for (let i = 0; i < constraint.path.length; i += 1) {
    const pathId = constraint.path[i];
    target = null;
    if (pathId.namespace === PRIMITIVE_NS) {
      if (i !== constraint.path.length - 1) {
        logger.error('Encountered a constraint path containing a primitive %s at index %d that was not the leaf: %s', pathId, i, constraint.toString());
        return {};
      }
      if (!currentDef.value) {
        logger.error('Encountered a constraint path with a primitive leaf %s on an element that lacked a value: %s', pathId, constraint.toString());
        return {};
      }
      if (currentDef.value instanceof ChoiceValue) {
        target = findOptionInChoice(currentDef.value, pathId, dataElementSpecs);
        if (!target) {
          logger.error('Encountered a constraint path with a primitive leaf %s on an element with a mismatched value: %s on valueDef %s', pathId, constraint.toString(), valueDef.toString());
          return {};
        }
      } else if (!pathId.equals(currentDef.value.identifier)) {
        logger.error('Encountered a constraint path with a primitive leaf %s on an element with a mismatched value: %s on valueDef %s', pathId, constraint.toString(), valueDef.toString());
        return {};
      } else {
        target = currentDef.value;
      }
      normalizedPath.push('Value');
    } else {
      const newDef = dataElementSpecs.findByIdentifier(pathId);
      if (!newDef) {
        logger.error('Cannot resolve element definition for %s on constraint %s. ERROR_CODE:12029', pathId, constraint.toString());
        return {};
      }
      // See if the current definition has a value of the specified type.
      if (currentDef.value) {
        if (currentDef.value instanceof ChoiceValue) {
          target = findOptionInChoice(currentDef.value, pathId, dataElementSpecs);
        } else if (pathId.equals(currentDef.value.identifier) || checkHasBaseType(currentDef.value.identifier, pathId, dataElementSpecs)) {
          target = currentDef.value;
          normalizedPath.push('Value');
        }
      }

      if (!target) {
        if (!currentDef.fields || !currentDef.fields.length) {
          logger.error('Element %s lacked any fields or a value that matched %s as part of constraint %s', currentDef.identifier.fqn, pathId, constraint.toString());
          return {};
        } else {
          target = currentDef.fields.find((field) => pathId.equals(field.identifier));
          if (!target) {
            // It's possible that the field is actually defined as an "includes type" constraint on a list.
            // In this case, do nothing, because right now there isn't a valid way to represent further constraints
            // on includesType elements in the schema.
            if (valueDef.constraintsFilter.includesType.constraints.some(c => c.isA.equals(pathId))) {
              logger.warn('Cannot enforce constraint %s on Element %s since %s refers to an type introduced by an "includesType" constraint', constraint.toString(), currentDef.identifier.fqn, pathId);
            } else {
              logger.error('Element %s lacked a field or a value that matched %s as part of constraint %s', currentDef.identifier.fqn, pathId, constraint.toString());
            }
            return {};
          }
          normalizedPath.push(pathId.name);
        }
      }
      currentDef = newDef;
    }
  }

  return {path:normalizedPath, target};
}

function extractUnnormalizedConstraintPath(constraint, valueDef, dataElementSpecs) {
  let currentDef = dataElementSpecs.findByIdentifier(valueDef.effectiveIdentifier);
  const normalizedPath = [];
  const len = constraint.hasPath() ? constraint.path.length : 0;
  for (let i = 0; i < len; i += 1) {
    const pathId = constraint.path[i];
    if (pathId.namespace === PRIMITIVE_NS) {
      logger.error('Encountered an unnormalized constraint path containing a primitive %s at index %d: %s', pathId, i, constraint.toString());
      return {};
    }
    const newDef = dataElementSpecs.findByIdentifier(pathId);
    if (!newDef) {
      logger.error('Cannot resolve element definition for %s on constraint %s. ERROR_CODE:12029', pathId, constraint.toString());
      return {};
    }
    let found = false;
    // See if the current definition has a value of the specified type.
    if (currentDef.value) {
      if (currentDef.value instanceof ChoiceValue) {
        for (const choice of currentDef.value.aggregateOptions) {
          if (pathId.equals(choice.identifier) || checkHasBaseType(choice.identifier, pathId, dataElementSpecs)) {
            found = true;
            break;
          }
        }
      } else if (pathId.equals(currentDef.value.identifier) || checkHasBaseType(currentDef.value.identifier, pathId, dataElementSpecs)) {
        normalizedPath.push('Value');
        found = true;
      }
    }

    if (!found) {
      if (!currentDef.fields || !currentDef.fields.length) {
        logger.error('Element %s lacked any fields or a value that matched %s as part of constraint %s', currentDef.identifier.fqn, pathId, constraint.toString());
        return {};
      } else {
        const found = currentDef.fields.some((field) => pathId.equals(field.identifier));
        if (!found) {
          // It's possible that the field is actually defined as an "includes type" constraint on a list.
          // In this case, do nothing, because right now there isn't a valid way to represent includesType
          // constraints in the schema.
          if (valueDef.constraintsFilter.includesType.constraints.some(c => c.isA.equals(pathId))) {
            // TODO: Eventually, somehow, support includesType constraints
          } else {
            logger.error('Element %s lacked a field or a value that matched %s as part of constraint %s', currentDef.identifier.fqn, pathId, constraint.toString());
          }
          return {};
        }
        normalizedPath.push(pathId.name);
      }
    }
    currentDef = newDef;
  }

  if (!currentDef.value) {
    logger.error('Target of an unnormalized constraint: %s does not have a value. Constraint is: %s', currentDef.identifier.fqn, constraint.toString());
    return {};
  } else if (!(currentDef.value instanceof ChoiceValue)) {
    logger.error('Constraint should not be on the value (except for choices): %s in an expanded object model "%s". Ignoring constraint.', currentDef.identifier.fqn, constraint.toString());
    return {};
  }
  let target = currentDef.value;
  if ((constraint instanceof TypeConstraint) || (constraint instanceof IncludesTypeConstraint)) {
    target = findOptionInChoice(currentDef.value, constraint.isA, dataElementSpecs);
    if (!target) {
      logger.error('Target of an unnormalized constraint: %s was a choice value that did not have a valid option: %s', constraint.toString(), currentDef.identifier.fqn);
      return {};
    }
  }

  normalizedPath.push('Value');

  return {path:normalizedPath, target};
}

function makeExpandedEntryDefinitions(enclosingNamespace, baseSchemaURL) {
  const properties = {};
  for (const name of ['ShrId', 'EntryId', 'EntryType', 'FocalSubject', 'SubjectIsThirdPartyFlag', 'Narrative', 'Informant', 'Author', 'AssociatedEncounter', 'OriginalCreationDate', 'LastUpdateDate', 'Language']) {
    properties[name] = { $ref: makeRef(new Identifier('shr.base', name), enclosingNamespace, baseSchemaURL) };
  }
  properties.Version = { $ref: makeRef(new Identifier('shr.core', 'Version'), enclosingNamespace, baseSchemaURL) };
  return { properties, required: [
    'shr.base.ShrId',
    'shr.base.EntryId',
    'shr.base.EntryType',
    'shr.base.FocalSubject',
    'shr.base.OriginalCreationDate',
    'shr.base.LastUpdateDate'
  ]};
}

/**
 * Converts a DataElement concept into a code entry for the schema. (Codes are also represented as Concepts in the object model.)
 *
 * @param {Concept|TBD} concept - The concept to convert.
 * @return {{coding: List<{code: string, system: string, display: (string|undefined)}>}} The converted object. Display is optional.
 */
function makeConceptEntry(concept) {
  return { coding: [ makeCodingEntry(concept) ]};
}

/**
 * Converts a concept into a coding entry for the schema (used in code constraints and includes code constraints)
 *
 * @param {Concept|TBD} concept - The concept to convert.
 * @return {{code: string, system: string, display: (string|undefined)}} The converted object. Display is optional.
 */
function makeCodingEntry(concept) {
  if (concept instanceof TBD) {
    const ret = { code: 'TBD', system: 'urn:tbd' };
    if (concept.text) {
      ret.display = concept.text;
    }
    return ret;
  } else {
    const ret = { code: concept.code, system: concept.system };
    if (concept.display) {
      ret.display = concept.display;
    }
    return ret;
  }
}

/**
 * Determine if a value or one of its ancestors is or was a list.
 *
 * @param {Value} value - the value to test.
 * @return {boolean} True if the value or any of its ancestors ever had a cardinality greater than 1.
 */
function isOrWasAList(value) {
  if (value.card.isList) {
    return true;
  }
  const cardConstraints = value.constraintsFilter.own.card.constraints;
  return cardConstraints.some((oneCard) => oneCard.isList);
}

/**
 * Searches the aggregate options of a choice for the specified option.
 *
 * @param {ChoiceValue} choice - the choice to evaluate.
 * @param {Identifier} optionId - the identifier to find in the choice.
 * @param {DataElementSpecifications} dataElementSpecs - The available DataElement specs.
 * @returns {Value?} The first option in the choice that matches the specified optionId.
 */
function findOptionInChoice(choice, optionId, dataElementSpecs) {
  // First look for a direct match
  for (const option of choice.aggregateOptions) {
    if (optionId.equals(option.identifier)) {
      return option;
    }
  }
  // Then look for a match on one of the selected options's base types
  // E.g., if choice has Quantity but selected option is IntegerQuantity
  for (const option of choice.aggregateOptions) {
    if (checkHasBaseType(optionId, option.identifier, dataElementSpecs)) {
      return option;
    }
  }
  return null;
}

function checkHasBaseType(identifier, baseIdentifier, dataElementSpecs) {
  if (typeof identifier === 'undefined' || typeof baseIdentifier === 'undefined') {
    return false;
  }
  const basedOns = getRecursiveBasedOns(identifier, dataElementSpecs);
  return basedOns.some(id => id.equals(baseIdentifier));
}

function getRecursiveBasedOns(identifier, dataElementSpecs, alreadyProcessed = []) {
  // If it's primitive or we've already processed this one, don't go further (avoid circular dependencies)
  if (identifier.isPrimitive || alreadyProcessed.some(id => id.equals(identifier))) {
    return alreadyProcessed;
  }

  // We haven't processed it, so look it up
  const element = dataElementSpecs.findByIdentifier(identifier);
  if (typeof element === 'undefined') {
    logger.error('Cannot resolve element definition for %s. ERROR_CODE:12029', identifier.fqn);
    return alreadyProcessed;
  }
  // Add it to the already processed list (again, to avoid circular dependencies)
  alreadyProcessed.push(identifier);
  // Now recursively get the BasedOns for each of the BasedOns
  for (const basedOn of element.basedOn) {
    alreadyProcessed = getRecursiveBasedOns(basedOn, dataElementSpecs, alreadyProcessed);
  }

  return alreadyProcessed;
}
// done stealing from shr-expand

module.exports = {exportToJSONSchema, setLogger, MODELS_INFO };
