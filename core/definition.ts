import { Dictionary, arrayInsertAfter } from '../common/collection';
import { stringCompare } from '../common/utils';
import * as logger from './logger';
import * as xml from './xml';
import { schema, DefSchemaType, Schema } from './schema';

// ======== Utils ========

export function getDefName(def: xml.Element): string | undefined {
  return xml.getChildElementText(def, 'defName');
}

export function isAbstract(def: xml.Element): boolean {
  return def.attributes.Abstract === 'True';
}

/**
 * Parse the XML documents plain text to RimWorld Definition data.
 * @param rawContents key for file path, value for XML plain text.
 */
export function parse(rawContents: Dictionary<string>): Dictionary<xml.Element[]> {
  const data: Dictionary<xml.Element[]> = {};

  Object.entries(rawContents)
    .sort((a, b) => stringCompare(a[0], b[0]))
    .map(([path, content]) => {
      try {
        const root: xml.Element = xml.parse(content);
        root.attributes.Path = path;

        return root;
      } catch (error) {
        logger.error(`Failed to parse Defs file: "${path}".\n${(error as Error).stack}`);
      }

      return undefined;
    })
    .forEach(root => {
      if (!root) {
        return;
      }

      let comment: string | undefined;
      let markDefs: Dictionary<boolean> = {};
      root.nodes.forEach(node => {
        if (
          xml.isComment(node) &&
          node.value &&
          !node.value.includes('\n') &&
          [...new Set(node.value.replace(/\s/g, ''))].length > 2
        ) {
          comment = node.value;
          markDefs = {};
        } else if (xml.isElement(node)) {
          if (comment && !markDefs[node.name]) {
            markDefs[node.name] = true;
            node.attributes.Comment = comment;
          }
          node.attributes.Path = root.attributes.Path;
          (data[node.name] || (data[node.name] = [])).push(node);
        }
      });
    });

  return data;
}

// ======== Inheritance ========

interface InheritanceNode {
  def: xml.Element;
  // resolvedDef: xml.Element;
  // data: Dictionary<xml.Element[]>;
  parent?: string;
  children: InheritanceNode[];
}

interface NodeMap {
  [name: string]: InheritanceNode;
}

interface InheritanceMap {
  [defType: string]: NodeMap;
}

/**
 * Resolve the Defs inheritance.
 * @param dataList The Defs data of mods. Order by the load order.
 */
export function resolveInheritance(dataList: Dictionary<xml.Element[]>[]): void {
  const mapList: InheritanceMap[] = [];

  dataList.forEach(data => {
    const inheritanceMap: InheritanceMap = {};
    mapList.unshift(inheritanceMap);

    Object.entries(data).forEach(([defType, definitions]) => {
      const nodeMap: NodeMap = {};
      inheritanceMap[defType] = nodeMap;

      definitions.filter(def => def.attributes.Name).forEach(
        def =>
          (nodeMap[def.attributes.Name as string] = {
            def,
            children: [],
          }),
      );

      // tslint:disable-next-line:typedef
      const getParentNode = (def: xml.Element): InheritanceNode | undefined => {
        if (!def.attributes.ParentName) {
          return undefined;
        }

        let parentNode: InheritanceNode | undefined;
        for (const map of mapList) {
          if (map[defType] && map[defType][def.attributes.ParentName]) {
            parentNode = map[defType][def.attributes.ParentName];
            break;
          }
        }

        return parentNode;
      };

      definitions
        .filter(def => def.attributes.Name && def.attributes.ParentName)
        .map<[InheritanceNode, InheritanceNode | undefined]>(def => [
          nodeMap[def.attributes.Name as string],
          getParentNode(def),
        ])
        .forEach(([node, parent]) => {
          if (parent) {
            node.parent = parent.def.attributes.Name as string;
            parent.children.push(node);
          }
        });

      definitions
        .filter(def => !def.attributes.Name && def.attributes.ParentName)
        .forEach(def => {
          const parent: InheritanceNode | undefined = getParentNode(def);
          if (parent) {
            parent.children.push({
              def,
              parent: parent.def.attributes.Name as string,
              children: [],
            });
          }
        });
    });
  });

  mapList.forEach(map =>
    Object.entries(map).forEach(([defType, nodeMap]) => {
      Object.values(nodeMap)
        .filter(node => !node.parent)
        .forEach(resolveNodeRecursively);
    }),
  );
}

function resolveNodeRecursively(node: InheritanceNode): void {
  node.children.forEach(child => {
    child.def.attributes.Inherited = 'True';
    elementInheritRecursively(child.def, node.def);
    resolveNodeRecursively(child);
  });
}

function elementInheritRecursively(child: xml.Element, parent: xml.Element): void {
  if (child.attributes.Inherit === 'false') {
    return;
  }

  if (child.nodes.every(xml.isElementByName('li'))) {
    parent.nodes
      .filter(xml.isElementByName('li'))
      .forEach(elP => child.nodes.push(xml.clone(elP)));

    return;
  }

  parent.nodes.filter(xml.isElement).forEach(elP => {
    const elC: xml.Element | undefined = child.nodes.find(xml.isElementByName(elP.name));
    if (elC) {
      if (!elC.nodes.every(xml.isText) && !elP.nodes.every(xml.isText)) {
        elementInheritRecursively(elC, elP);
      }
    } else {
      child.nodes.push(xml.clone(elP));
    }
  });
}

// ======== Post process ========

/**
 * Post process data after resolve inheritance: list item, generate defs, etc.
 */
export function postProcess(
  dataList: Dictionary<xml.Element[]>[],
): Dictionary<Dictionary<xml.Element>>[] {
  const actions: ((data: Dictionary<xml.Element[]>) => void)[] = [
    resolveListItemIndex,
    generateThingDef_Building,
    generateThingDef_Corpses,
    generateThingDef_Meat,
    generateTerrainDef_Stone,
    generateRecipeDef,
    generatePawnColumnDefs,
    generateKeyBindingCategoryDefs,
    generateKeyBindingDefs,
    resolveThingDefs_Mote,
  ];

  dataList.forEach(data => actions.forEach(a => a(data)));

  return dataList.map(resolveDuplicatedAndGenerateMap);
}

// ==== List Item ====

function resolveListItemIndexRecursively(element: xml.Element): void {
  element.nodes
    .filter(xml.isElementByName('li'))
    .forEach((li, index) => (li.attributes.Index = index));

  element.nodes.filter(xml.isElement).forEach(resolveListItemIndexRecursively);
}

function resolveListItemIndex(data: Dictionary<xml.Element[]>): void {
  Object.entries(data).forEach(([defType, defs]) =>
    defs.forEach(resolveListItemIndexRecursively),
  );
}

// ==== ThingDefGenerator_Building ====

const prefixBlueprintDefName: string = 'Blueprint_';
const prefixInstallBlueprintDefName: string = 'Install_';
const prefixBuildingFrameDefName: string = 'Frame_';

function isBuildableByPlayer(def: xml.Element): boolean {
  return def.nodes.some(xml.isElementByName('designationCategory'));
}

function isMinifiable(def: xml.Element): boolean {
  return def.nodes.some(xml.isElementByName('minifiedDef'));
}

function newBlueprintDef(
  def: xml.Element,
  isInstallBlueprint: boolean = false,
): xml.Element {
  const defName: string = getDefName(def) as string;
  const attributes: xml.Attributes = {
    ...def.attributes,
    SourceDefType: def.name,
    SourceDef: defName,
  };
  if (def.name === 'TerrainDef') {
    attributes.Path = 'ThingDefs_Buildings/_Terrain_Extra.xml';
  }

  return xml.createElement('ThingDef', attributes, [
    xml.createElement(
      'defName',
      isInstallBlueprint
        ? `${prefixBlueprintDefName}${prefixInstallBlueprintDefName}${defName}`
        : `${prefixBlueprintDefName}${defName}`,
    ),
    xml.createElement('label', 'BlueprintLabelExtra'),
  ]);
}

function newFrameDef(def: xml.Element): xml.Element {
  const defName: string = getDefName(def) as string;
  const attributes: xml.Attributes = {
    ...def.attributes,
    SourceDefType: def.name,
    SourceDef: defName,
  };
  if (def.name === 'TerrainDef') {
    attributes.Path = 'ThingDefs_Buildings/_Terrain_Extra.xml';
  }

  return xml.createElement('ThingDef', attributes, [
    xml.createElement('defName', `${prefixBuildingFrameDefName}${defName}`),
    xml.createElement('label', 'FrameLabelExtra'),
    ...(def.name === 'TerrainDef'
      ? [xml.createElement('description', 'Terrain building in progress.')]
      : []),
    xml.createElement('description', ''),
  ]);
}

function generateThingDef_Building(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach((def, index) => {
      if (isAbstract(def)) {
        return;
      }
      if (isBuildableByPlayer(def)) {
        arrayInsertAfter(
          data.ThingDef,
          index,
          newBlueprintDef(def),
          ...(isMinifiable(def) ? [newBlueprintDef(def, true)] : []),
          newFrameDef(def),
        );
      } else if (isMinifiable(def)) {
        arrayInsertAfter(data.ThingDef, index, newBlueprintDef(def, true));
      }
    });
  }
  if (data.TerrainDef) {
    data.TerrainDef.forEach(def => {
      if (isAbstract(def)) {
        return;
      }
      if (isBuildableByPlayer(def)) {
        if (!data.ThingDef) {
          data.ThingDef = [];
        }
        data.ThingDef.push(newBlueprintDef(def), newFrameDef(def));
      }
    });
  }
}

// ==== ThingDefGenerator_Corpses ====

function generateThingDef_Corpses(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach((def, index) => {
      if (isAbstract(def)) {
        return;
      }
      if (xml.getChildElementText(def, 'category') === 'Pawn') {
        const defName: string = getDefName(def) as string;
        arrayInsertAfter(
          data.ThingDef,
          index,
          xml.createElement(
            'ThingDef',
            { ...def.attributes, SourceDefType: 'ThingDef', SourceDef: defName },
            [
              xml.createElement('defName', `Corpse_${defName}`),
              xml.createElement('label', 'CorpseLabel'),
              xml.createElement('description', 'CorpseDesc'),
            ],
          ),
        );
      }
    });
  }
}

// ==== ThingDefGenerator_Meat ====

function generateThingDef_Meat(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach((def, index) => {
      if (isAbstract(def)) {
        return;
      }
      if (xml.getChildElementText(def, 'category') === 'Pawn') {
        const race: xml.Element | undefined = def.nodes.find(xml.isElementByName('race'));
        if (race) {
          const useMeatFrom: string | undefined = xml.getChildElementText(
            def,
            'useMeatFrom',
          );
          const fleshType: string | undefined = xml.getChildElementText(def, 'fleshType');
          const intelligence: string | undefined = xml.getChildElementText(
            def,
            'intelligence',
          );
          if (!useMeatFrom && fleshType !== 'Mechanoid') {
            const defName: string = getDefName(def) as string;
            arrayInsertAfter(
              data.ThingDef,
              index,
              xml.createElement(
                'ThingDef',
                { ...def.attributes, SourceDefType: 'ThingDef', SourceDef: defName },
                [
                  xml.createElement('defName', `Meat_${defName}`),
                  xml.createElement('label', 'MeatLabel'),
                  xml.createElement(
                    'description',
                    intelligence === 'Humanlike'
                      ? 'MeatHumanDesc'
                      : fleshType === 'Insectoid'
                        ? 'MeatInsectDesc'
                        : 'MeatDesc',
                  ),
                ],
              ),
            );
          }
        }
      }
    });
  }
}

// ==== TerrainDefGenerator_Stone ====

function generateTerrainDef_Stone(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach((def, index) => {
      if (isAbstract(def)) {
        return;
      }
      const building: xml.Element | undefined = def.nodes.find(
        xml.isElementByName('building'),
      );
      if (
        building &&
        xml.getChildElementText(building, 'isNaturalRock') === 'true' &&
        xml.getChildElementText(building, 'isResourceRock') === 'false'
      ) {
        const defName: string = getDefName(def) as string;
        const terrains: xml.Element[] = [
          xml.createElement(
            'TerrainDef',
            { ...def.attributes, SourceDefType: 'TerrainDef', SourceDef: defName },
            [
              xml.createElement('defName', `${defName}_Rough`),
              xml.createElement('label', 'RoughStoneTerrainLabel'),
              xml.createElement('description', 'RoughStoneTerrainDesc'),
            ],
          ),
          xml.createElement(
            'TerrainDef',
            { ...def.attributes, SourceDefType: 'TerrainDef', SourceDef: defName },
            [
              xml.createElement('defName', `${defName}_RoughHewn`),
              xml.createElement('label', 'RoughHewnStoneTerrainLabel'),
              xml.createElement('description', 'RoughHewnStoneTerrainDesc'),
            ],
          ),
          xml.createElement(
            'TerrainDef',
            { ...def.attributes, SourceDefType: 'TerrainDef', SourceDef: defName },
            [
              xml.createElement('defName', `${defName}_Smooth`),
              xml.createElement('label', 'SmoothStoneTerrainLabel'),
              xml.createElement('description', 'SmoothStoneTerrainDesc'),
            ],
          ),
        ];
        terrains.forEach(
          t => (t.attributes.Path = 'TerrainDefs/_Terrain_Extra_Stone.xml'),
        );

        (data.TerrainDef || (data.TerrainDef = [])).push(...terrains);
      }
    });
  }
}

// ==== RecipeDefGenerator ====

function generateRecipeDef(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach((def, index) => {
      if (isAbstract(def)) {
        return;
      }
      {
        const recipeMaker: xml.Element | undefined = def.nodes.find(
          xml.isElementByName('recipeMaker'),
        );
        if (recipeMaker) {
          const defName: string = getDefName(def) as string;
          const recipe: xml.Element = xml.createElement(
            'RecipeDef',
            { ...def.attributes, SourceDefType: 'ThingDef', SourceDef: defName },
            [
              xml.createElement('defName', `Make_${defName}`),
              xml.createElement('label', 'RecipeMake'),
              xml.createElement('description', ''),
              xml.createElement('jobString', 'RecipeMakeJobString'),
            ],
          );
          recipe.attributes.Path = 'RecipeDefs/_Recipe_Extra_Make.xml';

          (data.RecipeDef || (data.RecipeDef = [])).push(recipe);
        }
      }
      {
        const ingestible: xml.Element | undefined = def.nodes.find(
          xml.isElementByName('ingestible'),
        );
        if (
          ingestible &&
          xml.getChildElementText(ingestible, 'drugCategory') !== 'None'
        ) {
          const defName: string = getDefName(def) as string;
          const recipe: xml.Element = xml.createElement(
            'RecipeDef',
            { ...def.attributes, SourceDefType: 'ThingDef', SourceDef: defName },
            [
              xml.createElement('defName', `Administer_${defName}`),
              xml.createElement('label', 'RecipeAdminister'),
              xml.createElement('jobString', 'RecipeAdministerJobString'),
            ],
          );
          recipe.attributes.Path = 'RecipeDefs/_Recipe_Extra_Administer.xml';

          (data.RecipeDef || (data.RecipeDef = [])).push(recipe);
        }
      }
    });
  }
}

// ==== PawnColumnDefGenerator ====

function generatePawnColumnDefs(data: Dictionary<xml.Element[]>): void {
  if (data.TrainableDef) {
    data.TrainableDef.map(def => {
      def.attributes.Index = parseFloat(
        xml.getChildElementText(def, 'listPriority') || '0',
      );

      return def;
    })
      .sort((a, b) => {
        if (
          a.attributes.Index !== undefined &&
          !isNaN(a.attributes.Index) &&
          b.attributes.Index !== undefined &&
          !isNaN(b.attributes.Index)
        ) {
          return b.attributes.Index - a.attributes.Index; // descending
        } else {
          return 0;
        }
      })
      .forEach((def, index) => {
        if (isAbstract(def)) {
          return;
        }
        const defName: string = getDefName(def) as string;
        const column: xml.Element = xml.createElement(
          'PawnColumnDef',
          { ...def.attributes, SourceDefType: 'TrainableDef', SourceDef: defName },
          [
            xml.createElement('defName', `Trainable_${defName}`),
            xml.createElement('headerTip', 'LabelCap'),
          ],
        );
        column.attributes.Path = 'Misc/PawnColumnDefs/_PawnColumn_Extra.xml';

        (data.PawnColumnDef || (data.PawnColumnDef = [])).push(column);
      });
  }
  // if (data.WorkTypeDef) {
  //   data.WorkTypeDef.filter(wt => xml.getChildElementText(wt, 'visible') !== 'false')
  //     .sort((a, b) => {
  //       const A: number = parseInt(xml.getChildElementText(a, 'naturalPriority') || '0', 10);
  //       const B: number = parseInt(xml.getChildElementText(b, 'naturalPriority') || '0', 10);
  //       if (!isNaN(A) && !isNaN(B)) {
  //         return A - B; // ascending
  //       } else {
  //         return 0;
  //       }
  //     })
  //     .forEach((def, index) => {
  //       if (isAbstract(def)) {
  //         return;
  //       }
  //     })
  // }
}

// ==== KeyBindingDefGenerator ====

function generateKeyBindingCategoryDefs(data: Dictionary<xml.Element[]>): void {
  if (data.DesignationCategoryDef) {
    data.DesignationCategoryDef.forEach((def, index) => {
      const defName: string = getDefName(def) as string;
      const category: xml.Element = xml.createElement(
        'KeyBindingCategoryDef',
        {
          ...def.attributes,
          SourceDefType: 'DesignationCategoryDef',
          SourceDef: defName,
        },
        [
          xml.createElement('defName', `Architect_${defName}`),
          xml.createElement('label', '{0} tab'),
          xml.createElement(
            'description',
            'Key bindings for the "{0}" section of the Architect menu.',
          ),
        ],
      );
      category.attributes.Path = 'Misc/KeyBindings/_KeyBindingCategoryDef_Extra.xml';

      (data.KeyBindingCategoryDef || (data.KeyBindingCategoryDef = [])).push(category);
    });
  }
}

function generateKeyBindingDefs(data: Dictionary<xml.Element[]>): void {
  if (data.MainButtonDef) {
    data.MainButtonDef.forEach((def, index) => {
      const defName: string = getDefName(def) as string;
      const key: xml.Element = xml.createElement(
        'KeyBindingDef',
        { ...def.attributes, SourceDefType: 'MainButtonDef', SourceDef: defName },
        [
          xml.createElement('defName', `MainTab_${defName}`),
          xml.createElement('label', 'Toggle {0} tab'),
        ],
      );
      key.attributes.Path = 'Misc/KeyBindings/_KeyBinding_Extra.xml';

      (data.KeyBindingDef || (data.KeyBindingDef = [])).push(key);
    });
  }
}

function resolveThingDefs_Mote(data: Dictionary<xml.Element[]>): void {
  if (data.ThingDef) {
    data.ThingDef.forEach(def => {
      if (xml.getChildElementText(def, 'category') === 'Mote') {
        def.attributes.Path = 'Effects/_Mote_Special.xml';
      }
    });
  }
}

// ==== Resolve Duplicated ====

function resolveDuplicatedAndGenerateMap(
  data: Dictionary<xml.Element[]>,
): Dictionary<Dictionary<xml.Element>> {
  const map: Dictionary<Dictionary<xml.Element>> = {};

  Object.entries(data).forEach(([defType, defs]) => {
    if ((schema as Schema)[defType] === DefSchemaType.NoTranslate) {
      return;
    }

    const subMap: Dictionary<xml.Element> = {};
    map[defType] = subMap;

    defs.forEach(def => {
      if (isAbstract(def)) {
        return;
      }
      const defName: string | undefined = getDefName(def);
      if (defName) {
        subMap[defName] = def;
      } else {
        // TODO
      }
    });

    Object.entries(subMap).forEach(([defName, def]) => (def.attributes.Instanced = true));
  });

  return map;
}

// ==== Prepare PawnKindDef ====

export function prepareForExtract(mapList: Dictionary<Dictionary<xml.Element>>[]): void {
  [preparePawnKindDef].forEach(pre => pre(mapList));
}

function preparePawnKindDef(mapList: Dictionary<Dictionary<xml.Element>>[]): void {
  // tslint:disable-next-line:typedef
  const getLifeStage = (lifeStageDefName: string): xml.Element | undefined => {
    for (let i: number = mapList.length - 1; i > -1; i--) {
      const map: Dictionary<Dictionary<xml.Element>> = mapList[i];
      if (map.LifeStageDef && map.LifeStageDef[lifeStageDefName]) {
        return map.LifeStageDef[lifeStageDefName];
      }
    }

    return undefined;
  };

  // tslint:disable-next-line:typedef
  const getRace = (raceDefName: string): xml.Element | undefined => {
    for (let i: number = mapList.length - 1; i > -1; i--) {
      const map: Dictionary<Dictionary<xml.Element>> = mapList[i];
      if (map.ThingDef && map.ThingDef[raceDefName]) {
        return map.ThingDef[raceDefName];
      }
    }

    return undefined;
  };

  // tslint:disable-next-line:typedef
  const bindHook = (pawnKindDef: xml.Element): void => {
    const raceDef: xml.Element | undefined = getRace(
      xml.getChildElementText(pawnKindDef, 'race') || '',
    );
    const race: xml.Element | undefined =
      raceDef && raceDef.nodes.find(xml.isElementByName('race'));

    // Check if has genders
    pawnKindDef.attributes.HasGenders =
      !race || xml.getChildElementText(race, 'hasGenders') !== 'false';

    // Check if is humanlike
    const intelligence: string | undefined =
      race && xml.getChildElementText(race, 'intelligence');
    pawnKindDef.attributes.Humanlike =
      !!intelligence && (intelligence !== 'Animal' && intelligence !== 'ToolUser');

    // Check life stage visible
    const lifeStages: xml.Element | undefined = pawnKindDef.nodes.find(
      xml.isElementByName('lifeStages'),
    );
    const lifeStageAges: xml.Element | undefined =
      race && race.nodes.find(xml.isElementByName('lifeStageAges'));
    if (lifeStages && lifeStageAges) {
      const lifeStageItems: xml.Element[] = lifeStages.nodes.filter(
        xml.isElementByName('li'),
      );
      lifeStageAges.nodes
        .filter(xml.isElementByName('li'))
        .map(age => {
          const lifeStageDef: xml.Element | undefined = getLifeStage(
            xml.getChildElementText(age, 'def') || '',
          );

          return (
            lifeStageDef && xml.getChildElementText(lifeStageDef, 'visible') !== 'false'
          );
        })
        .forEach((value, index) => {
          if (lifeStageItems[index]) {
            lifeStageItems[index].attributes.Visible = value;
          }
        });
    }
  };

  mapList.forEach(map => {
    if (!map.PawnKindDef) {
      return;
    }
    Object.entries(map.PawnKindDef).forEach(([defName, pawnKindDef]) => {
      bindHook(pawnKindDef);
    });
  });
}
