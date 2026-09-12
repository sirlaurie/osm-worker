import { type Poi, ServiceError } from "./data.ts";
import { distanceMeters } from "./geo.ts";

export interface PoiItem {
  id: string;
  name: string;
  poiCategory: string;
  subCategory: string;
  coordinate: { latitude: number; longitude: number };
  distanceMeters: number;
  extraDetails: Record<string, string>;
  rawTags: Record<string, string>;
}

export interface MatchedPoi {
  poi: Poi;
  name: string;
  classification: [string, string];
  distanceMeters: number;
}

const SUBWAY_ENTRANCE_RE = /subway_entrance|entrance/i;

export function classifyOsmTags(
  tags: Record<string, string>,
): [string, string] | null {
  if (tags.amenity) {
    const val = tags.amenity;

    if (["restaurant", "fast_food", "food_court"].includes(val))
      return ["Food", "Restaurant / Fast food"];

    if (val === "cafe") return ["Food", "Cafe"];

    if (["bar", "pub", "biergarten"].includes(val))
      return ["Food", "Bar / Pub"];

    if (["bank", "atm"].includes(val)) return ["Service", "Bank / ATM"];

    if (["pharmacy", "clinic", "hospital", "doctors", "dentist"].includes(val))
      return ["Health", "Medical care / Pharmacy"];

    if (
      ["school", "university", "college", "kindergarten", "library"].includes(
        val,
      )
    )
      return ["Education", "Education / Culture"];

    if (["parking", "fuel", "charging_station", "bus_station"].includes(val))
      return ["Transport", "Transport / Fuel / Charging"];

    if (val === "cinema") return ["Entertainment", "Cinema"];

    if (val === "theatre") return ["Entertainment", "Theatre"];
  }

  if (tags.shop) {
    const val = tags.shop;

    if (["convenience", "supermarket", "general"].includes(val))
      return ["Shopping", "Supermarket / Convenience store"];

    if (["bakery", "pastry"].includes(val)) return ["Food", "Bakery / Pastry"];

    if (["clothes", "shoes", "fashion", "boutique"].includes(val))
      return ["Shopping", "Clothing / Accessories"];

    if (["electronics", "mobile_phone"].includes(val))
      return ["Shopping", "Electronics"];

    return ["Shopping", `Shop (${val})`];
  }

  if (tags.railway) {
    const val = tags.railway;

    if (SUBWAY_ENTRANCE_RE.test(val) || val === "subway_entrance") {
      return [
        "Transport",
        tags.ref ? `Subway entrance (${tags.ref})` : "Subway entrance",
      ];
    }

    if (val === "station" || val === "halt")
      return ["Transport", "Train / Rail station"];

    return ["Transport", `Railway facility (${val})`];
  }

  if (tags.tourism) {
    const val = tags.tourism;

    if (["hotel", "motel", "hostel", "guest_house"].includes(val))
      return ["Tourism", "Accommodation"];

    if (
      [
        "attraction",
        "museum",
        "gallery",
        "theme_park",
        "zoo",
        "aquarium",
        "viewpoint",
      ].includes(val)
    ) {
      return ["Tourism", "Attraction / Exhibition"];
    }

    return ["Tourism", `Tourism (${val})`];
  }

  if (tags.leisure) {
    const val = tags.leisure;

    if (["park", "garden"].includes(val)) return ["Tourism", "Park / Garden"];

    if (
      ["fitness_centre", "sports_centre", "swimming_pool", "pitch"].includes(
        val,
      )
    ) {
      return ["Entertainment", "Sports / Fitness"];
    }

    return ["Entertainment", `Leisure (${val})`];
  }

  if (tags.highway && ["bus_stop", "platform"].includes(tags.highway)) {
    return ["Transport", "Bus stop"];
  }

  if (tags.healthcare) {
    return ["Health", `Healthcare (${tags.healthcare})`];
  }

  return null;
}

function placeNames(tags: Record<string, string>): string[] {
  return [
    tags["name:zh"],
    tags.name,
    tags["name:en"],
    tags.int_name,
    ...Object.entries(tags)
      .filter(([key]) => /^name:[a-z]{2,3}(?:[-_][a-z0-9]+)*$/i.test(key))
      .map(([, value]) => value),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizedName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function matchPoi(
  poi: Poi,
  lat: number,
  lon: number,
  radius: number,
  query: string,
): MatchedPoi | null {
  const names = placeNames(poi.tags);
  const classification = classifyOsmTags(poi.tags);
  const name = names[0];

  if (!name || !classification) throw new ServiceError(503, "invalid_poi");

  const distance = distanceMeters(lat, lon, poi.lat, poi.lon);

  if (distance > radius) return null;

  const normalized = normalizedName(query.trim());

  if (
    normalized &&
    !names.some((value) => normalizedName(value).includes(normalized))
  )
    return null;

  return { poi, name, classification, distanceMeters: distance };
}

export function formatPoi(match: MatchedPoi): PoiItem {
  const { poi, name, classification, distanceMeters } = match;

  const extra: Record<string, string> = {};

  for (const key of [
    "opening_hours",
    "wheelchair",
    "brand",
    "operator",
    "cuisine",
    "stars",
    "level",
  ]) {
    if (poi.tags[key]) extra[key] = poi.tags[key];
  }

  const phone = poi.tags.phone || poi.tags["contact:phone"];
  const website = poi.tags.website || poi.tags["contact:website"];

  if (phone) extra.phone = phone;

  if (website) extra.website = website;

  return {
    id: poi.id,
    name,
    poiCategory: classification[0],
    subCategory: classification[1],
    coordinate: {
      latitude: Number(poi.lat.toFixed(6)),
      longitude: Number(poi.lon.toFixed(6)),
    },
    distanceMeters,
    extraDetails: extra,
    rawTags: poi.tags,
  };
}
