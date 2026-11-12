import type { AgDataSourcesDefinition, AgFieldDefinition, AgReportState } from "ag-studio";
import { STUDIO_FIELDS, STUDIO_TABLES, type StudioSnapshot, type StudioTable } from "./contracts";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
export const studioMoney = (minor: number) => usd.format(minor / 100);
export const TABLE_LABELS: Record<StudioTable, string> = {
  packages: "Packages · one row per budget", settlements: "Settlement receipts · both payment rails",
  allocations: "Allocation revisions · real lineage", evidence: "Evidence · scoped source associations",
  funding_positions: "Current purposes · conserved receipt credit",
  exceptions: "Reconciliation · attention needed",
};
const descriptions: Record<StudioTable, string> = {
  packages: "One row per package. Sum budgetMinor only at this grain. All money fields are integer USD cents. Net collected and funding eligible include conditional Orders captures and invoice payments; exclude sandbox_test. Approved expenses are receipt review, not paid expenses or accepted physical work. No spending is available until a funded round is complete.",
  settlements: "One row per role-visible settlement receipt. Donors see their own receipts. Provider gross includes possible excess liability. fundingEligibleMinor excludes sandbox_test. Never infer a provider balance from stored observations.",
  allocations: "One row per actual immutable allocation revision. activeAllocationMinor is nonzero only for the latest reserved or paid revision; use it for totals. allocationMinor is historical and must never be summed across revisions. Empty means no allocation exists; never draw invented donor-to-expense lineage.",
  funding_positions: "Separately versioned current-purpose positions. One row per original receipt and current package; paired donor choices move credit without duplicating payment. Original settlement rows retain economic lineage. Donors see only their own contributions. A historical report without this dataset remains unchanged; empty historical positions must not be reconstructed from today's ledger.",
  evidence: "One row per visible evidence/package association. A receipt may have separate reviewed amounts in two packages. amountMinor is the amount for this association, never a repeated receipt total. Accepted work evidence, expense review, and principal payment establish different facts. Private originals exist only for permitted roles.",
  exceptions: "Planning and prerequisite issues, shortfalls after some collection, uncollected items, incomplete refunds, and held expense lines visible to this role at this cutoff. Payout, fee, return-hold and command issues may appear separately. An empty table does not establish complete reconciliation. Affected amounts can overlap; never sum them as a balance. A missing operation has no provider outcome.",
};

/** The browser receives only an already redacted projection. No raw provider or source records. */
export function studioDataDefinition(snapshot: StudioSnapshot): AgDataSourcesDefinition {
  return {
    description: `Fieldproof private report. Role: ${snapshot.role}. Provenance: ${snapshot.mode}. Cutoff: ${snapshot.asOf}. ${snapshot.notices.join(" ")} Amounts are integer cents, formatted as USD only at display time. The data is descriptive; it cannot authorize a charge, refund, payout, publication, or physical signoff.`,
    sources: STUDIO_TABLES.map(table => ({
      id: table, name: TABLE_LABELS[table], description: descriptions[table], primaryKeyField: "id", transactions: "all",
      data: (snapshot.data[table] ?? []).map(row => ({ ...row })),
      fields: STUDIO_FIELDS[table].map((field): AgFieldDefinition => ({
        id: field.id, name: field.name, description: field.description,
        format: ({ text: "textFormat", number: "integerFormat", boolean: "booleanFormat", datetime: "dateTimeFormat" } as const)[field.kind], editable: false,
        cardinality: field.id === "id" ? "high" : undefined,
        notBlank: field.id === "id" || field.id === "packageId",
        context: { fieldproof: { table, unit: field.unit ?? null } },
        ...(field.unit === "usd_minor" ? { createValueFormatter: () => value => value == null ? "—" : studioMoney(Number(value)) } : {}),
      })),
    })),
    relationships: (["settlements", "allocations", "funding_positions", "evidence", "exceptions"] as const).map(table => ({
      id: `package-${table}`, type: "one-to-many", source: "packages.packageId", target: `${table}.packageId`,
    })),
    // The common package dimension connects the facts. A receipt-to-allocation link in addition
    // would create an ambiguous cycle; lineage is rendered using its explicit receipt identity.
    options: { fanout: { execute: "prevent", warning: true }, nullHandling: { emptyCount: "zero" } },
  };
}

export const STUDIO_WIDGET_TABLES = {
  "fieldproof-blueprint": "packages", "fieldproof-rings": "packages", "fieldproof-allocation": "allocations",
  "fieldproof-evidence": "evidence", "fieldproof-matrix": "packages", "fieldproof-exceptions": "exceptions",
} as const;
export type FieldproofWidgetId = keyof typeof STUDIO_WIDGET_TABLES;
export const WIDGET_TITLES: Record<FieldproofWidgetId, string> = {
  "fieldproof-blueprint": "A room for possibility", "fieldproof-rings": "Commitment, collection, proof",
  "fieldproof-allocation": "Follow the contribution", "fieldproof-evidence": "The evidence shelf",
  "fieldproof-matrix": "Every package, clearly", "fieldproof-exceptions": "What needs a human",
};

export function studioDefaultState(): AgReportState {
  const widget = (type: FieldproofWidgetId) => {
    const table = STUDIO_WIDGET_TABLES[type];
    return { type, dataMapping: { rows: [{ id: `${table}.id` }], package: [{ id: `${table}.packageId` }] },
      format: { title: { enabled: true, text: WIDGET_TITLES[type] }, crossFilter: "filter", triggerCrossFilter: true } };
  };
  // Custom registry state is validated by Studio once the six definitions are registered.
  return {
    pages: [{ id: "field-notes", widgets: {
      blueprint: widget("fieldproof-blueprint"), rings: widget("fieldproof-rings"),
      matrix: widget("fieldproof-matrix"), evidence: widget("fieldproof-evidence"),
      allocation: widget("fieldproof-allocation"), exceptions: widget("fieldproof-exceptions"),
    }, widgetLayout: {
      blueprint: { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 25 },
      rings: { xTrack: 14, yTrack: 0, xSpan: 10, ySpan: 25 },
      matrix: { xTrack: 0, yTrack: 25, xSpan: 14, ySpan: 23 },
      evidence: { xTrack: 14, yTrack: 25, xSpan: 10, ySpan: 23 },
      allocation: { xTrack: 0, yTrack: 48, xSpan: 14, ySpan: 22 },
      exceptions: { xTrack: 14, yTrack: 48, xSpan: 10, ySpan: 22 },
    }, layout: { type: "widget", minWidth: 0, columns: 24, rowHeight: 18, pagePadding: 14, widgetPadding: 18, widgetBackgroundColor: "#FFFEFA", backgroundColor: "#F4F1EA", widgetBorderRadius: 16 } }],
    selectedPageId: "field-notes", panels: { data: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: true }, edit: { collapsed: true } },
  } as unknown as AgReportState;
}
