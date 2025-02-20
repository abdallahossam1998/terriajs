import { Geometry, GeometryCollection, Properties } from "@turf/helpers";
import i18next from "i18next";
import { computed, runInAction } from "mobx";
import Cartesian3 from "terriajs-cesium/Source/Core/Cartesian3";
import Color from "terriajs-cesium/Source/Core/Color";
import BillboardGraphics from "terriajs-cesium/Source/DataSources/BillboardGraphics";
import ColorMaterialProperty from "terriajs-cesium/Source/DataSources/ColorMaterialProperty";
import ConstantProperty from "terriajs-cesium/Source/DataSources/ConstantProperty";
import Entity from "terriajs-cesium/Source/DataSources/Entity";
import GeoJsonDataSource from "terriajs-cesium/Source/DataSources/GeoJsonDataSource";
import PointGraphics from "terriajs-cesium/Source/DataSources/PointGraphics";
import PolygonGraphics from "terriajs-cesium/Source/DataSources/PolygonGraphics";
import PolylineDashMaterialProperty from "terriajs-cesium/Source/DataSources/PolylineDashMaterialProperty";
import PolylineGraphics from "terriajs-cesium/Source/DataSources/PolylineGraphics";
import HeightReference from "terriajs-cesium/Source/Scene/HeightReference";
import URI from "urijs";
import isDefined from "../../../Core/isDefined";
import loadJson from "../../../Core/loadJson";
import makeRealPromise from "../../../Core/makeRealPromise";
import replaceUnderscores from "../../../Core/replaceUnderscores";
import { networkRequestError } from "../../../Core/TerriaError";
import featureDataToGeoJson from "../../../Map/featureDataToGeoJson";
import proj4definitions from "../../../Map/Proj4Definitions";
import CatalogMemberMixin from "../../../ModelMixins/CatalogMemberMixin";
import GeoJsonMixin, {
  FeatureCollectionWithCrs
} from "../../../ModelMixins/GeojsonMixin";
import UrlMixin from "../../../ModelMixins/UrlMixin";
import ArcGisFeatureServerCatalogItemTraits from "../../../Traits/TraitsClasses/ArcGisFeatureServerCatalogItemTraits";
import { InfoSectionTraits } from "../../../Traits/TraitsClasses/CatalogMemberTraits";
import LegendTraits, {
  LegendItemTraits
} from "../../../Traits/TraitsClasses/LegendTraits";
import { RectangleTraits } from "../../../Traits/TraitsClasses/MappableTraits";
import CreateModel from "../../Definition/CreateModel";
import createStratumInstance from "../../Definition/createStratumInstance";
import LoadableStratum from "../../Definition/LoadableStratum";
import { BaseModel } from "../../Definition/Model";
import StratumFromTraits from "../../Definition/StratumFromTraits";
import StratumOrder from "../../Definition/StratumOrder";
import proxyCatalogItemUrl from "../proxyCatalogItemUrl";
import { getLineStyleCesium } from "./esriLineStyle";

const proj4 = require("proj4").default;

interface DocumentInfo {
  Author?: string;
}

type esriStyleTypes =
  | "esriPMS" // simple picture style
  | "esriSMS" // simple marker style
  | "esriSLS" // simple line style
  | "esriSFS"; // simple fill style

//as defined https://developers.arcgis.com/web-map-specification/objects/esriSLS_symbol/

type supportedFillStyle =
  | "esriSFSSolid" // fill line with color
  | "esriSFSNull"; // no fill

// as defined https://developers.arcgis.com/web-map-specification/objects/esriSMS_symbol/
type supportedSimpleMarkerStyle =
  | "esriSMSCircle"
  | "esriSMSCross"
  | "esriSMSDiamond"
  | "esriSMSSquare"
  | "esriSMSTriangle"
  | "esriSMSX";

export type supportedLineStyle =
  | "esriSLSSolid" // solid line
  | "esriSLSDash" // dashes (-----)
  | "esriSLSDashDot" // line (-.-.-)
  | "esriSLSDashDotDot" // line (-..-..-)
  | "esriSLSDot" // dotted line (.....)
  | "esriSLSLongDash"
  | "esriSLSLongDashDot"
  | "esriSLSShortDash"
  | "esriSLSShortDashDot"
  | "esriSLSShortDashDotDot"
  | "esriSLSShortDot"
  | "esriSLSNull";

const defaultColor = [255, 255, 255, 255];
const defaultFillColor = [255, 255, 255, 1];
const defaultOutlineColor = [0, 0, 0, 255];

// See actual Symbol at https://developers.arcgis.com/web-map-specification/objects/symbol/
interface Symbol {
  contentType: string;
  color?: number[];
  outline?: Outline;
  imageData?: any;
  xoffset?: number;
  yoffset?: number;
  width?: number;
  height?: number;
  angle?: number;
  size?: number;
  type: esriStyleTypes;
  style?: supportedSimpleMarkerStyle | supportedLineStyle | supportedFillStyle;
}

interface Outline {
  type: esriStyleTypes;
  color: number[];
  width: number;
  style?: supportedLineStyle;
}

interface Renderer {
  type: string;
}

interface ClassBreakInfo extends SimpleRenderer {
  classMaxValue: number;
  classMinValue?: number;
}

interface ClassBreaksRenderer extends Renderer {
  field: string;
  classBreakInfos: ClassBreakInfo[];
  defaultSymbol: Symbol | null;
}

interface UniqueValueInfo extends SimpleRenderer {
  value: string;
}

interface UniqueValueRenderer extends Renderer {
  field1: string;
  field2?: string;
  field3?: string;
  fieldDelimiter?: string;
  uniqueValueInfos: UniqueValueInfo[];
  defaultSymbol: Symbol | null;
}

interface SimpleRenderer extends Renderer {
  label?: string;
  symbol: Symbol | null;
}

interface DrawingInfo {
  renderer: Renderer;
}

interface FeatureServer {
  documentInfo?: DocumentInfo;
  name?: string;
  description?: string;
  copyrightText?: string;
  drawingInfo?: DrawingInfo;
  extent?: Extent;
  maxScale?: number;
  advancedQueryCapabilities?: {
    supportsPagination: boolean;
  };
}

interface SpatialReference {
  wkid?: string;
  latestWkid?: string;
}

interface Extent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: SpatialReference;
}

class FeatureServerStratum extends LoadableStratum(
  ArcGisFeatureServerCatalogItemTraits
) {
  static stratumName = "featureServer";

  constructor(
    private readonly _item: ArcGisFeatureServerCatalogItem,
    private readonly _featureServer?: FeatureServer,
    private _esriJson?: any
  ) {
    super();
  }

  duplicateLoadableStratum(newModel: BaseModel): this {
    return new FeatureServerStratum(
      newModel as ArcGisFeatureServerCatalogItem,
      this._esriJson
    ) as this;
  }

  @computed
  get featureServerData(): FeatureServer | undefined {
    return this._featureServer;
  }

  static async load(
    item: ArcGisFeatureServerCatalogItem
  ): Promise<FeatureServerStratum> {
    if (item.url === undefined) {
      new FeatureServerStratum(item, undefined, undefined);
    }
    const metaUrl = buildMetadataUrl(item);
    const featureServer = await loadJson(metaUrl);

    const stratum = new FeatureServerStratum(item, featureServer, undefined);

    return stratum;
  }

  @computed get forceCesiumPrimitives(): boolean {
    return this._item.useStyleInformationFromService;
  }

  @computed
  get shortReport(): string | undefined {
    // Show notice if reached
    if (
      this._item.readyData?.features !== undefined &&
      this._item.readyData!.features.length >= this._item.maxFeatures
    ) {
      return i18next.t(
        "models.arcGisFeatureServerCatalogItem.reachedMaxFeatureLimit",
        this._item
      );
    }
    return undefined;
  }

  @computed get maximumScale(): number | undefined {
    return this._featureServer?.maxScale;
  }

  @computed get name(): string | undefined {
    if (
      this._featureServer?.name !== undefined &&
      this._featureServer.name.length > 0
    ) {
      return replaceUnderscores(this._featureServer.name);
    }
  }

  @computed get dataCustodian(): string | undefined {
    if (
      this._featureServer?.documentInfo &&
      this._featureServer?.documentInfo.Author &&
      this._featureServer?.documentInfo.Author.length > 0
    ) {
      return this._featureServer.documentInfo.Author;
    }
  }

  @computed get rectangle(): StratumFromTraits<RectangleTraits> | undefined {
    const extent = this._featureServer?.extent;
    const wkidCode =
      extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid;

    if (isDefined(extent) && isDefined(wkidCode)) {
      const wkid = "EPSG:" + wkidCode;
      if (!isDefined((proj4definitions as any)[wkid])) {
        return undefined;
      }

      const source = new proj4.Proj((proj4definitions as any)[wkid]);
      const dest = new proj4.Proj("EPSG:4326");

      let p = proj4(source, dest, [extent.xmin, extent.ymin]);

      const west = p[0];
      const south = p[1];

      p = proj4(source, dest, [extent.xmax, extent.ymax]);

      const east = p[0];
      const north = p[1];

      const rectangle = { west: west, south: south, east: east, north: north };
      return createStratumInstance(RectangleTraits, rectangle);
    }

    return undefined;
  }

  @computed get info() {
    return [
      createStratumInstance(InfoSectionTraits, {
        name: i18next.t("models.arcGisMapServerCatalogItem.dataDescription"),
        content: this._featureServer?.description
      }),
      createStratumInstance(InfoSectionTraits, {
        name: i18next.t("models.arcGisMapServerCatalogItem.copyrightText"),
        content: this._featureServer?.copyrightText
      })
    ];
  }

  @computed get supportsPagination(): boolean {
    if (
      this._featureServer === undefined ||
      this._featureServer.advancedQueryCapabilities === undefined
    ) {
      return false;
    }

    return !!this._featureServer.advancedQueryCapabilities.supportsPagination;
  }

  @computed get legends(): StratumFromTraits<LegendTraits>[] | undefined {
    if (
      !this._item.useStyleInformationFromService ||
      !this._featureServer?.drawingInfo
    ) {
      return undefined;
    }
    const renderer = this._featureServer.drawingInfo.renderer;
    const rendererType = renderer.type;
    let infos: SimpleRenderer[] | UniqueValueInfo[] | ClassBreakInfo[];

    if (rendererType === "uniqueValue") {
      infos = (<UniqueValueRenderer>renderer).uniqueValueInfos;
    } else if (rendererType === "classBreaks") {
      infos = (<ClassBreaksRenderer>renderer).classBreakInfos;
    } else if (rendererType === "simple") {
      infos = [<SimpleRenderer>renderer];
    } else {
      return undefined;
    }

    const items: StratumFromTraits<LegendItemTraits>[] = [];

    infos.forEach(info => {
      const label = replaceUnderscores(info.label);
      const symbol = info.symbol;
      if (!symbol || symbol.style === "esriSLSNull") {
        return;
      }
      const color = symbol.color;
      const imageUrl = symbol.imageData
        ? proxyCatalogItemUrl(
            this._item,
            `data:${symbol.contentType};base64,${symbol.imageData}`
          )
        : undefined;
      const outlineColor = symbol.outline?.color;
      items.push(
        createStratumInstance(LegendItemTraits, {
          title: label,
          imageUrl,
          color: color
            ? convertEsriColorToCesiumColor(color).toCssColorString()
            : undefined,
          outlineColor: outlineColor
            ? convertEsriColorToCesiumColor(outlineColor).toCssColorString()
            : undefined
        })
      );
    });
    return [createStratumInstance(LegendTraits, { items })];
  }
}

StratumOrder.addLoadStratum(FeatureServerStratum.stratumName);

export default class ArcGisFeatureServerCatalogItem extends GeoJsonMixin(
  UrlMixin(
    CatalogMemberMixin(CreateModel(ArcGisFeatureServerCatalogItemTraits))
  )
) {
  static readonly type = "esri-featureServer";

  get type(): string {
    return ArcGisFeatureServerCatalogItem.type;
  }

  get typeName(): string {
    return i18next.t("models.arcGisFeatureServerCatalogItem.name");
  }

  protected async forceLoadMetadata(): Promise<void> {
    if (this.strata.get(FeatureServerStratum.stratumName) === undefined) {
      const stratum = await FeatureServerStratum.load(this);
      runInAction(() => {
        this.strata.set(FeatureServerStratum.stratumName, stratum);
      });
    }
  }

  protected async forceLoadGeojsonData(): Promise<
    FeatureCollectionWithCrs<Geometry | GeometryCollection, Properties>
  > {
    const getEsriLayerJson = async (resultOffset?: number) =>
      await loadJson(this.buildEsriJsonUrl(resultOffset));

    if (!this.supportsPagination) {
      // Make a single request without pagination
      return (
        featureDataToGeoJson(await getEsriLayerJson()) ?? {
          type: "FeatureCollection",
          features: []
        }
      );
    }

    // Esri Feature Servers have a maximum limit to how many features they'll return at once, so for a service with many
    // features, we have to make multiple requests. We can't figure out how many features we need to request ahead of
    // time (there's an API for it but it times out for services with thousands of features), so we just keep trying
    // until we run out of features or hit the limit
    const featuresPerRequest = this.featuresPerRequest;
    const maxFeatures = this.maxFeatures;
    let combinedEsriLayerJson = await getEsriLayerJson(0);

    const mapObjectIds = (features: any) =>
      features.map(
        (feature: any) =>
          feature.attributes.OBJECTID ?? feature.attributes.objectid
      );
    const seenIDs: Set<string> = new Set(
      mapObjectIds(combinedEsriLayerJson.features)
    );

    let currentOffset = 0;
    let exceededTransferLimit = combinedEsriLayerJson.exceededTransferLimit;
    while (
      combinedEsriLayerJson.features.length <= maxFeatures &&
      exceededTransferLimit === true
    ) {
      currentOffset += featuresPerRequest;
      const newEsriLayerJson = await getEsriLayerJson(currentOffset);
      if (
        newEsriLayerJson.features === undefined ||
        newEsriLayerJson.features.length === 0
      ) {
        break;
      }

      const newIds: string[] = mapObjectIds(newEsriLayerJson.features);

      if (newIds.every((id: string) => seenIDs.has(id))) {
        // We're getting data that we've received already, assume have everything we need and stop fetching
        break;
      }

      newIds.forEach(id => seenIDs.add(id));
      combinedEsriLayerJson.features = combinedEsriLayerJson.features.concat(
        newEsriLayerJson.features
      );
      exceededTransferLimit = newEsriLayerJson.exceededTransferLimit;
    }

    return (
      featureDataToGeoJson(combinedEsriLayerJson) ?? {
        type: "FeatureCollection",
        features: []
      }
    );
  }

  protected async loadGeoJsonDataSource(
    geoJson: FeatureCollectionWithCrs
  ): Promise<GeoJsonDataSource> {
    const dataSource = await super.loadGeoJsonDataSource(geoJson);

    const featureServerData = this.featureServerData;
    if (
      !this.useStyleInformationFromService ||
      featureServerData === undefined ||
      featureServerData.drawingInfo === undefined
    ) {
      // Use GeoJSONMixin styles
      return dataSource;
    }
    const renderer = featureServerData!.drawingInfo!.renderer;
    const rendererType = renderer.type;

    const entities = dataSource.entities;
    entities.suspendEvents();

    // A 'simple' renderer only applies a single style to all features
    if (rendererType === "simple") {
      const simpleRenderer = <SimpleRenderer>renderer;
      const symbol = simpleRenderer.symbol;
      if (symbol) {
        entities.values.forEach(entity => {
          updateEntityWithEsriStyle(entity, symbol, this);
        });
      }

      // For a 'uniqueValue' renderer symbology gets applied via feature properties.
    } else if (renderer.type === "uniqueValue") {
      const uniqueValueRenderer = <UniqueValueRenderer>renderer;
      const rendererObj = setupUniqueValueRenderer(uniqueValueRenderer);
      entities.values.forEach(entity => {
        const symbol = getUniqueValueSymbol(
          entity,
          uniqueValueRenderer,
          rendererObj
        );
        if (symbol) {
          updateEntityWithEsriStyle(entity, symbol, this);
        }
      });

      // For a 'classBreaks' renderer symbology gets applied via classes or ranges of data.
    } else if (renderer.type === "classBreaks") {
      const classBreaksRenderer = <ClassBreaksRenderer>renderer;
      entities.values.forEach(entity => {
        const symbol = getClassBreaksSymbol(entity, classBreaksRenderer);
        if (symbol) {
          updateEntityWithEsriStyle(entity, symbol, this);
        }
      });
    }

    entities.resumeEvents();
    return dataSource;
  }

  @computed get featureServerData(): FeatureServer | undefined {
    const stratum = <FeatureServerStratum>(
      this.strata.get(FeatureServerStratum.stratumName)
    );
    return isDefined(stratum) ? stratum.featureServerData : undefined;
  }

  /**
   * Constructs the url for a request to a feature server
   * @param resultOffset Allows for pagination of results.
   *  See https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer-.htm
   */
  buildEsriJsonUrl(resultOffset?: number) {
    const url = cleanUrl(this.url || "0d");
    const urlComponents = splitLayerIdFromPath(url);
    const layerId = urlComponents.layerId;

    if (!isDefined(layerId)) {
      throw networkRequestError({
        title: i18next.t(
          "models.arcGisFeatureServerCatalogItem.invalidServiceTitle"
        ),
        message: i18next.t(
          "models.arcGisFeatureServerCatalogItem.invalidServiceMessage"
        )
      });
    }

    // We used to make a call to a different ArcGIS API endpoint
    // (https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-.htm) which took a
    // `layerdef` parameter, which is more or less equivalent to `where`. To avoid breaking old catalog items, we need
    // to use `layerDef` if `where` hasn't been set
    const where = this.where === "1=1" ? this.layerDef : this.where;

    const uri = new URI(url)
      .segment("query")
      .addQuery("f", "json")
      .addQuery("where", where)
      .addQuery("outFields", "*")
      .addQuery("outSR", "4326");

    if (resultOffset !== undefined) {
      // Pagination specific parameters
      uri
        .addQuery("resultRecordCount", this.featuresPerRequest)
        .addQuery("resultOffset", resultOffset);
    }

    return proxyCatalogItemUrl(this, uri.toString());
  }
}

function setupUniqueValueRenderer(renderer: UniqueValueRenderer) {
  const out: any = {};
  for (var i = 0; i < renderer.uniqueValueInfos.length; i++) {
    const val = renderer.uniqueValueInfos[i].value;
    out[val] = renderer.uniqueValueInfos[i];
  }
  return out;
}

function getUniqueValueSymbol(
  entity: Entity,
  uniqueValueRenderer: UniqueValueRenderer,
  rendererObj: any
): Symbol | null {
  if (!entity.properties) {
    return uniqueValueRenderer.defaultSymbol;
  }

  let entityUniqueValue = entity.properties[
    uniqueValueRenderer.field1
  ].getValue();

  // accumulate values if there is more than one field defined
  if (uniqueValueRenderer.fieldDelimiter && uniqueValueRenderer.field2) {
    const val2 = entity.properties[uniqueValueRenderer.field2].getValue();

    if (val2) {
      entityUniqueValue += uniqueValueRenderer.fieldDelimiter + val2;

      if (uniqueValueRenderer.field3) {
        const val3 = entity.properties[uniqueValueRenderer.field3].getValue();

        if (val3) {
          entityUniqueValue += uniqueValueRenderer.fieldDelimiter + val3;
        }
      }
    }
  }

  const uniqueValueInfo = rendererObj[entityUniqueValue];

  if (uniqueValueInfo && uniqueValueInfo.symbol) {
    return uniqueValueInfo.symbol;
  } else {
    return uniqueValueRenderer.defaultSymbol;
  }
}

function getClassBreaksSymbol(
  entity: Entity,
  classBreaksRenderer: ClassBreaksRenderer
): Symbol | null {
  if (!entity.properties) {
    return classBreaksRenderer.defaultSymbol;
  }

  let entityValue = entity.properties[classBreaksRenderer.field].getValue();
  for (var i = 0; i < classBreaksRenderer.classBreakInfos.length; i++) {
    if (entityValue <= classBreaksRenderer.classBreakInfos[i].classMaxValue) {
      return classBreaksRenderer.classBreakInfos[i].symbol;
    }
  }

  return classBreaksRenderer.defaultSymbol;
}

export function convertEsriColorToCesiumColor(esriColor: number[]): Color {
  return Color.fromBytes(
    esriColor[0],
    esriColor[1],
    esriColor[2],
    esriColor[3]
  );
}

function updateEntityWithEsriStyle(
  entity: Entity,
  symbol: Symbol,
  catalogItem: ArcGisFeatureServerCatalogItem
): void {
  // type of geometry is point and the applied style is image
  // TODO: tweek the svg support
  if (symbol.type === "esriPMS") {
    // Replace a general Cesium Point with a billboard
    entity.point = entity.point ?? new PointGraphics();
    if (symbol.imageData) {
      entity.billboard = new BillboardGraphics({
        image: new ConstantProperty(
          proxyCatalogItemUrl(
            catalogItem,
            `data:${symbol.contentType};base64,${symbol.imageData}`
          )
        ),
        heightReference: new ConstantProperty(
          catalogItem.clampToGround
            ? HeightReference.RELATIVE_TO_GROUND
            : undefined
        ),
        width: new ConstantProperty(
          convertEsriPointSizeToPixels(symbol.width!)
        ),
        height: new ConstantProperty(
          convertEsriPointSizeToPixels(symbol.height!)
        ),
        rotation: new ConstantProperty(symbol.angle)
      });

      if (symbol.xoffset || symbol.yoffset) {
        const x = isDefined(symbol.xoffset) ? symbol.xoffset : 0;
        const y = isDefined(symbol.yoffset) ? symbol.yoffset : 0;
        entity.billboard.pixelOffset = new ConstantProperty(
          new Cartesian3(x, y)
        );
      }

      entity.point.show = new ConstantProperty(false);
    }
  } else if (symbol.type === "esriSMS") {
    // Update the styling of the Cesium Point
    // TODO extend support for cross, diamond, square, x, triangle
    entity.point = entity.point ?? new PointGraphics();
    if (symbol.color) {
      entity.point.color = new ConstantProperty(
        convertEsriColorToCesiumColor(symbol.color)
      );
      entity.point.pixelSize = new ConstantProperty(
        convertEsriPointSizeToPixels(symbol.size!)
      );

      if (symbol.outline) {
        entity.point.outlineColor = new ConstantProperty(
          convertEsriColorToCesiumColor(symbol.outline.color)
        );
        entity.point.outlineWidth = new ConstantProperty(
          convertEsriPointSizeToPixels(symbol.outline.width)
        );
      }
    }
  } else if (symbol.type === "esriSLS") {
    /* Update the styling of the Cesium Polyline */
    entity.polyline = entity.polyline ?? new PolylineGraphics();
    if (isDefined(symbol.width)) {
      entity.polyline.width = new ConstantProperty(
        convertEsriPointSizeToPixels(symbol.width)
      );
    }
    const color = symbol.color ? symbol.color : defaultColor;
    /*
        For line containing dashes PolylineDashMaterialProperty is used.
        Definition is done using the line patterns converted from hex to decimal dashPattern.
        Source for some of the line patterns is https://www.opengl.org.ru/docs/pg/0204.html, others are created manually
      */
    esriPolylineStyle(entity, color, <supportedLineStyle>symbol.style);
  } else if (symbol.type === "esriSFS") {
    // Update the styling of the Cesium Polygon
    entity.polygon = entity.polygon ?? new PolygonGraphics();
    const color = symbol.color ? symbol.color : defaultFillColor;

    // feature picking doesn't work when the polygon interior is transparent, so
    // use an almost-transparent color instead
    if (color[3] === 0) {
      color[3] = 1;
    }
    entity.polygon.material = new ColorMaterialProperty(
      new ConstantProperty(convertEsriColorToCesiumColor(color))
    );

    if (
      symbol.style === "esriSFSNull" &&
      symbol.outline &&
      symbol.outline.style === "esriSLSNull"
    ) {
      entity.polygon.show = new ConstantProperty(false);
    } else {
      entity.polygon.material = new ColorMaterialProperty(
        new ConstantProperty(convertEsriColorToCesiumColor(color))
      );
    }
    if (symbol.outline) {
      const outlineColor = symbol.outline.color
        ? symbol.outline.color
        : defaultOutlineColor;
      /* It can actually happen that entity has both polygon and polyline defined at same time,
            check the implementation of GeoJsonCatalogItem for details. */
      entity.polygon.outlineColor = new ColorMaterialProperty(
        new ConstantProperty(convertEsriColorToCesiumColor(outlineColor))
      );
      entity.polygon.outlineWidth = new ConstantProperty(
        convertEsriPointSizeToPixels(symbol.outline.width)
      );
      entity.polyline = entity.polyline ?? new PolylineGraphics();
      esriPolylineStyle(entity, outlineColor, symbol.outline.style);
      entity.polyline.width = new ConstantProperty(
        convertEsriPointSizeToPixels(symbol.outline.width)
      );
      entity.polygon.outline = entity.polyline.material;
    }
  }
}

function esriPolylineStyle(
  entity: Entity,
  color: number[],
  style?: supportedLineStyle
): void {
  if (entity.polyline) {
    if (style) {
      const patternValue = getLineStyleCesium(style);
      if (patternValue) {
        entity.polyline.material = new PolylineDashMaterialProperty({
          color: convertEsriColorToCesiumColor(color),
          dashPattern: new ConstantProperty(patternValue)
        });
      } else if (style === "esriSLSSolid") {
        // it is simple line just define color
        entity.polyline.material = new ColorMaterialProperty(
          convertEsriColorToCesiumColor(color)
        );
      } else if (style === "esriSLSDash") {
        // default PolylineDashMaterialProperty is dashed line ` -` (0x00FF)
        entity.polyline.material = new PolylineDashMaterialProperty({
          color: convertEsriColorToCesiumColor(color)
        });
      }
    } else {
      // we don't know how to handle style make it default
      entity.polyline.material = new ColorMaterialProperty(
        convertEsriColorToCesiumColor(color)
      );
    }

    if (style === "esriSLSNull") {
      entity.polyline.show = new ConstantProperty(false);
    }
  }
}

// ESRI uses points for styling while cesium uses pixels
export function convertEsriPointSizeToPixels(pointSize: number) {
  // 1 px = 0.75 point
  // 1 point = 4/3 point
  return (pointSize * 4) / 3;
}

function buildMetadataUrl(catalogItem: ArcGisFeatureServerCatalogItem) {
  return proxyCatalogItemUrl(
    catalogItem,
    new URI(catalogItem.url).addQuery("f", "json").toString()
  );
}

function splitLayerIdFromPath(url: string) {
  const regex = /^(.*FeatureServer)\/(\d+)/;
  const matches = url.match(regex);
  if (isDefined(matches) && matches !== null && matches.length > 2) {
    return {
      layerId: matches[2],
      urlWithoutLayerId: matches[1]
    };
  }
  return {
    urlWithoutLayerId: url
  };
}

function cleanUrl(url: string): string {
  // Strip off the search portion of the URL
  const uri = new URI(url);
  uri.search("");
  return uri.toString();
}
