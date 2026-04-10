type DistanceType = "short" | "medium" | "long";
type TeamGroup = "move" | "loaders" | "unloading";
type EstimateGroup = "home" | "storage" | "office";

type DistanceCharge = {
  distanceType: DistanceType;
  charge: number;
};

type TeamRate = {
  teamGroup: TeamGroup;
  teamOption: string;
  rate: number;
  minimumHours: number;
};

type LaborEstimate = {
  estimateGroup: EstimateGroup;
  estimateOption: string;
  minLabor: number;
  maxLabor: number;
};

export const WIDGET_20_PRICING = {
  widgetId: 20,
  distanceCharges: [
    { distanceType: "short", charge: 0 },
    { distanceType: "medium", charge: 10 },
    { distanceType: "long", charge: 20 },
  ] satisfies DistanceCharge[],
  travel: {
    travelRate: 0.8,
    pricePerMile: 2.5,
  },
  teamRates: [
    { teamGroup: "move", teamOption: "2-1", rate: 165, minimumHours: 2 },
    { teamGroup: "move", teamOption: "3-1", rate: 209, minimumHours: 3 },
    { teamGroup: "move", teamOption: "4-1", rate: 253, minimumHours: 2 },
    { teamGroup: "move", teamOption: "4-2", rate: 299, minimumHours: 2 },
    { teamGroup: "move", teamOption: "5-2", rate: 341, minimumHours: 2 },
    { teamGroup: "loaders", teamOption: "loaders-2", rate: 120, minimumHours: 2 },
    { teamGroup: "loaders", teamOption: "loaders-3", rate: 180, minimumHours: 2 },
    { teamGroup: "unloading", teamOption: "2-1", rate: 10, minimumHours: 2 },
    { teamGroup: "unloading", teamOption: "3-1", rate: 0, minimumHours: 2 },
  ] satisfies TeamRate[],
  stairsCharge: {
    stairsRange: "1-2",
    charge: 10,
  },
  protectionCharge: 15,
  noElevatorCharge: 10,
  laborEstimates: [
    { estimateGroup: "home", estimateOption: "studio", minLabor: 3, maxLabor: 3 },
    { estimateGroup: "home", estimateOption: "1bed", minLabor: 2.5, maxLabor: 3.5 },
    { estimateGroup: "home", estimateOption: "2bed", minLabor: 3, maxLabor: 4 },
    { estimateGroup: "home", estimateOption: "3bed", minLabor: 4, maxLabor: 5 },
    { estimateGroup: "home", estimateOption: "4bed", minLabor: 5, maxLabor: 6 },
    { estimateGroup: "home", estimateOption: "5bed", minLabor: 6, maxLabor: 8 },
    { estimateGroup: "storage", estimateOption: "25", minLabor: 1, maxLabor: 1.5 },
    { estimateGroup: "storage", estimateOption: "50", minLabor: 1.5, maxLabor: 2 },
    { estimateGroup: "storage", estimateOption: "75", minLabor: 2, maxLabor: 2.5 },
    { estimateGroup: "storage", estimateOption: "100", minLabor: 2.5, maxLabor: 3 },
    { estimateGroup: "storage", estimateOption: "200", minLabor: 3, maxLabor: 4 },
    { estimateGroup: "storage", estimateOption: "300", minLabor: 4, maxLabor: 5 },
    { estimateGroup: "office", estimateOption: "1-4", minLabor: 2, maxLabor: 3 },
    { estimateGroup: "office", estimateOption: "5-9", minLabor: 3, maxLabor: 4 },
    { estimateGroup: "office", estimateOption: "10-19", minLabor: 4, maxLabor: 5 },
    { estimateGroup: "office", estimateOption: "20-49", minLabor: 5, maxLabor: 7 },
    { estimateGroup: "office", estimateOption: "50-99", minLabor: 7, maxLabor: 9 },
    { estimateGroup: "office", estimateOption: "over-100", minLabor: 10, maxLabor: 12 },
  ] satisfies LaborEstimate[],
} as const;

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatHours(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

const distanceLines = WIDGET_20_PRICING.distanceCharges.map(
  ({ distanceType, charge }) => `- ${distanceType}: ${formatCurrency(charge)}`
);

const teamRateLines = WIDGET_20_PRICING.teamRates.map(
  ({ teamGroup, teamOption, rate, minimumHours }) =>
    `- ${teamGroup} ${teamOption}: rate ${formatCurrency(rate)}, minimum ${formatHours(minimumHours)} hours`
);

const laborEstimateLines = WIDGET_20_PRICING.laborEstimates.map(
  ({ estimateGroup, estimateOption, minLabor, maxLabor }) =>
    `- ${estimateGroup} ${estimateOption}: ${formatHours(minLabor)}-${formatHours(maxLabor)} labor hours`
);

export const PRICING_PROMPT_BLOCK = [
  `Current authoritative pricing for widget ${WIDGET_20_PRICING.widgetId}:`,
  "",
  "Distance surcharge bands:",
  ...distanceLines,
  "",
  "Travel:",
  `- Travel rate: ${WIDGET_20_PRICING.travel.travelRate.toFixed(4)}`,
  `- Price per mile: ${formatCurrency(WIDGET_20_PRICING.travel.pricePerMile)}`,
  "",
  "Crew and team rates:",
  ...teamRateLines,
  "",
  "Access and protection charges:",
  `- Stairs range ${WIDGET_20_PRICING.stairsCharge.stairsRange}: ${formatCurrency(WIDGET_20_PRICING.stairsCharge.charge)}`,
  `- No elevator charge: ${formatCurrency(WIDGET_20_PRICING.noElevatorCharge)}`,
  `- Protection charge: ${formatCurrency(WIDGET_20_PRICING.protectionCharge)}`,
  "",
  "Estimated labor windows:",
  ...laborEstimateLines,
].join("\n");

export const PRICING_SYSTEM_APPENDIX = [
  "Address requirements:",
  "- Require a complete pickup address and a complete delivery address before giving a final quote.",
  "- A complete address means street number, street name, city, state, and ZIP code. Include apartment, suite, or unit details when they apply.",
  "- A city-only answer such as Atlanta, a neighborhood name, or a partial landmark is not a complete address.",
  "- If either address is incomplete, ask a follow-up and do not treat the address as collected yet.",
  "",
  "Readiness rule:",
  "- As soon as you have complete pickup and delivery addresses, floor/elevator access details for both ends, enough inventory detail to choose a team and labor window, and a moving date or timeframe, give the quote in your very next reply.",
  "- Do not keep asking extra questions once the required quoting inputs are complete.",
  "- If a minor non-blocking detail is still missing, state the assumption you are making and provide the quote anyway.",
  "",
  PRICING_PROMPT_BLOCK,
  "",
  "Rules for quoting:",
  "- If any earlier instruction conflicts with the pricing above, use the pricing above.",
  "- Do not use legacy flat-base, extra-hour, per-floor, or box-size pricing that is not in this rate card.",
  "- Do not present a final quote until both addresses are complete.",
  "- If the move details do not map cleanly to one of the listed team or estimate options, ask clarifying questions before finalizing the quote.",
  "- Once the required quote inputs are complete, do not stall, recap unnecessarily, or ask optional discovery questions before quoting.",
  "- Present every quote as an itemized breakdown with the selected team option, labor estimate, travel, distance surcharge, access/protection charges, and total.",
].join("\n");
