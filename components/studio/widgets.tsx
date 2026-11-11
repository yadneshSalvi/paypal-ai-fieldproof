"use client";

import { useEffect, useId, useMemo, useState, type ComponentType } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, CircleHelp, FileCheck2, FileText, Focus, Image as ImageIcon, Layers3, Link2, LockKeyhole, ShieldCheck, TriangleAlert } from "lucide-react";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import type { AgDefaultWidgetDefinition, AgGridWidgetFormat, AgWidgetData, AgWidgetDataResponse, AgWidgetField, AgWidgetFieldReference, AgWidgetParams, AgWidgetsConfig } from "ag-studio";
import { STUDIO_FIELDS, type AllocationRow, type EvidenceRow, type ExceptionRow, type PackageRow, type StudioRow, type StudioSnapshot } from "@/lib/studio/contracts";
import { STUDIO_WIDGET_IDS } from "@/lib/studio/history";
import { STUDIO_WIDGET_TABLES, WIDGET_TITLES, studioMoney, type FieldproofWidgetId } from "@/lib/studio/native-data";

export type StudioDetail = { kind: "package" | "evidence" | "allocation" | "exception"; id: string };
export interface StudioWidgetContext { snapshot: StudioSnapshot; openDetail(detail: StudioDetail, trigger: HTMLElement): void; }
type WidgetState = AgWidgetData<{ rows: AgWidgetFieldReference[]; package: AgWidgetFieldReference[] }, AgGridWidgetFormat>;
type WidgetProps = AgWidgetParams<WidgetState, unknown, StudioWidgetContext>;
type FieldproofDefinition = AgWidgetDefinition<FieldproofWidgetId, WidgetState>;
export interface FieldproofRegistry extends AgRegistry { widgets: readonly (AgDefaultWidgetDefinition | FieldproofDefinition)[]; }
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown) => typeof value === "string" ? value : "";
const nice = (value: string) => value.replaceAll("_", " ");

/** Every draw starts from a native query. Fixed source fields preserve this widget's domain
 * grain; the visible rows and shared package field come from the persisted dataMapping. */
function useStudioRows<T extends StudioRow>(props: WidgetProps) {
  const { widgetType, widgetApi, dataMapping, format, sort } = props;
  const table = STUDIO_WIDGET_TABLES[widgetType as FieldproofWidgetId];
  const rowField = dataMapping.rows?.[0], packageField = dataMapping.package?.[0];
  const valid = rowField?.fieldId === `${table}.id` && !rowField.aggregation && packageField?.fieldId === `${table}.packageId` && !packageField.aggregation;
  const fields = useMemo(() => {
    const schemaFields = widgetApi.getSchema().find(item => item.id === table)?.fields ?? [];
    return STUDIO_FIELDS[table].flatMap(definition => {
      const field = schemaFields.find(item => item.fieldId === `${table}.${definition.id}` && !item.aggregation);
      return field ? [field] : [];
    });
  }, [table, widgetApi, rowField, packageField]);
  const [result, setResult] = useState<{ rows: T[]; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null });
  // Reading selections registers the native cross-filter refresh dependency.
  const selections = widgetApi.getCrossFilterSelections();
  const selected = new Set(selections?.flatMap(selection => selection.type === "value" && selection.field.fieldId === packageField?.fieldId ? selection.values.map(String) : []) ?? []);
  useEffect(() => {
    const abort = new AbortController();
    if (!valid) { widgetApi.setDisplayState("incompleteDataMapping"); return () => abort.abort(); }
    widgetApi.setDisplayState("loading", { prominent: false });
    const draw = (response: AgWidgetDataResponse) => {
      if (abort.signal.aborted || response.replaced) return;
      if (response.results.metadata?.error) {
        setResult({ rows: [], loading: false, error: "This view could not resolve its fields. Review its data mapping before using these totals." });
      } else {
        const rows = response.results.rows.map(row => Object.fromEntries(fields.map(field => [field.fieldId.slice(table.length + 1), row[field.key] ?? null])) as T);
        setResult({ rows, loading: false, error: null });
      }
      widgetApi.setDisplayState("displayed");
    };
    widgetApi.getData({ fields, sort }, { queryId: "fieldproof-rows", crossFilter: format?.crossFilter ?? "filter", signal: abort.signal, onDataUpdated: draw }).then(draw).catch(() => {
      if (!abort.signal.aborted) { setResult({ rows: [], loading: false, error: "This view is temporarily unavailable. Refresh the report to try again." }); widgetApi.setDisplayState("displayed"); }
    });
    return () => abort.abort();
  }, [fields, format?.crossFilter, sort, table, valid, widgetApi]);
  const select = (packageId: string) => {
    if (packageField && packageId) widgetApi.toggleCrossFilter({ type: "value", field: packageField, value: packageId, group: 0 });
  };
  return { ...result, valid, selected, select, clear: () => widgetApi.resetCrossFilter() };
}

function WidgetEmpty({ title, children, icon: Icon = Layers3 }: { title: string; children: React.ReactNode; icon?: ComponentType<{ size?: number; strokeWidth?: number }> }) {
  return <div className="studio-widget-empty"><span className="studio-empty-icon"><Icon size={26} strokeWidth={1.3}/></span><strong>{title}</strong><p>{children}</p></div>;
}
function QueryStatus({ result }: { result: ReturnType<typeof useStudioRows> }) {
  if (result.error) return <WidgetEmpty title="A clear answer needs a complete query" icon={TriangleAlert}>{result.error}</WidgetEmpty>;
  if (!result.valid) return <WidgetEmpty title="Choose this widget’s source fields">Use the stable row identity and package identity for its own table.</WidgetEmpty>;
  if (result.loading) return <div className="studio-widget-skeleton" role="status" aria-label="Loading report data"><span/><span/><span/></div>;
  return null;
}
function WidgetNote({ children }: { children: React.ReactNode }) { return <p className="studio-widget-note">{children}</p>; }
function PackageFilter({ result, count }: { result: ReturnType<typeof useStudioRows>; count: number }) {
  return <div className="studio-widget-filter"><span><Focus size={12}/>{result.selected.size ? `${result.selected.size} selected` : `${count} in view`}</span>{result.selected.size > 0 ? <button onClick={result.clear}>Clear selection</button> : <span>Click a package to connect the views</span>}</div>;
}

function BlueprintWidget(props: WidgetProps) {
  const result = useStudioRows<PackageRow>(props), gridId = useId().replaceAll(":", "");
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  const zones = result.rows.map(row => ({ row, zone: props.context.snapshot.geometry[text(row.geometryRef)] ?? props.context.snapshot.geometry[row.packageId] })).filter(item => item.zone);
  const source = props.context.snapshot.geometrySource;
  const planWidth = source ? Math.min(860, 370 * source.pageAspectRatio) : 860;
  const planHeight = source ? planWidth / source.pageAspectRatio : 360;
  const left = (1000 - planWidth) / 2, top = 100 + (370 - planHeight) / 2;
  return <div className="studio-blueprint-widget">
    <PackageFilter result={result} count={result.rows.length}/>
    {zones.length ? <div className="studio-plan-paper"><svg viewBox="0 0 1000 580" className="studio-plan-svg" role="group" aria-label="Illustrative room plan. Each package can be selected to filter the report.">
      <defs><pattern id={gridId} width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#4A6FA5" strokeWidth=".5" opacity=".16"/></pattern></defs>
      <rect width="1000" height="580" rx="14" fill="#EEF2F2"/><rect x="20" y="20" width="960" height="540" fill={`url(#${gridId})`}/>
      <path d="M40 86V40H182 M818 40H960V86 M960 494V540H818 M182 540H40V494" fill="none" stroke="#4A6FA5" strokeWidth="1.3"/>
      <text x="52" y="65" className="studio-plan-label">FIELD NOTES / ROOM PLAN</text>
      {source?.state === "current" && <polygon points={source.outline.map(point => `${left + point.x * planWidth},${top + point.y * planHeight}`).join(" ")} fill="none" stroke="#1E3A5F" strokeWidth="2"/>}
      {zones.map(({ row, zone }, index) => {
        const active = result.selected.has(row.packageId), points = zone.points.map(point => `${left + point.x * planWidth},${top + point.y * planHeight}`).join(" ");
        const x = left + zone.label.x * planWidth, y = top + zone.label.y * planHeight;
        const width = (Math.max(...zone.points.map(p => p.x)) - Math.min(...zone.points.map(p => p.x))) * planWidth;
        const height = (Math.max(...zone.points.map(p => p.y)) - Math.min(...zone.points.map(p => p.y))) * planHeight;
        const compact = width < 160 || height < 66;
        return <g key={row.id} role="button" tabIndex={0} aria-label={`${row.title}. ${studioMoney(row.collectedMinor)} collected of ${studioMoney(row.budgetMinor)}. Filter by this package.`} aria-pressed={active}
          className={`studio-plan-zone${active ? " is-selected" : ""}`} onClick={() => result.select(row.packageId)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); result.select(row.packageId); } }}>
          <title>{row.title} · {studioMoney(row.collectedMinor)} collected of {studioMoney(row.budgetMinor)}</title>
          <polygon points={points} fill={active ? "#F2A93B" : "#FFFEFA"} fillOpacity={active ? ".38" : ".85"} stroke={active ? "#1E3A5F" : "#4A6FA5"} strokeWidth={active ? 3 : 1.7}/>
          <text x={x} y={compact ? y + 4 : y - 4} textAnchor="middle" className="studio-zone-title">{compact ? String(index + 1).padStart(2, "0") : row.shortTitle || row.title}</text>
          {!compact && <><text x={x} y={y + 18} textAnchor="middle" className="studio-zone-amount">{studioMoney(row.collectedMinor)} / {studioMoney(row.budgetMinor)}</text><circle cx={x} cy={y + 38} r="3" fill={["accepted", "accepted_within_scope", "sample_review_complete"].includes(row.workState) ? "#3E8E5E" : "#F2A93B"}/></>}
        </g>;
      })}
      <text x="54" y="521" className="studio-plan-label">ILLUSTRATIVE GEOMETRY · NOT A SURVEY</text><path d="M792 517h145m-145-5v10m145-10v10" stroke="#4A6FA5"/><text x="831" y="505" className="studio-plan-label">NOT TO SCALE</text>
    </svg></div> : <WidgetEmpty title="A plan is still taking shape">Reviewed room geometry will appear here. The package records below already carry the current funding facts.</WidgetEmpty>}
    <div className="studio-plan-key">{result.rows.map((row, index) => <button key={row.id} aria-pressed={result.selected.has(row.packageId)} onClick={() => result.select(row.packageId)}><span>{String(index + 1).padStart(2, "0")}</span>{row.shortTitle || row.title}<ArrowDownRight size={13}/></button>)}</div>
    <WidgetNote>{source ? `Plan r${source.revision} · ${source.provenance === "sample" ? "sample" : "reviewed source"} · ${source.state}. ${source.scaleLabel}. ` : "Illustrative sample geometry. "}Room selection filters the native report. Receipt review does not certify the room or its safety.</WidgetNote>
  </div>;
}

function ProgressRing({ numerator, denominator, label, color, display }: { numerator: number; denominator: number; label: string; color: string; display: string }) {
  const ratio = denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0;
  return <div className="studio-progress-ring"><svg viewBox="0 0 120 120" role="img" aria-label={`${label}: ${display}`}><circle cx="60" cy="60" r="47" fill="none" stroke="#EAE6DB" strokeWidth="9"/><circle cx="60" cy="60" r="47" fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${ratio * 295.31} 295.31`} transform="rotate(-90 60 60)"/><text x="60" y="62" textAnchor="middle">{Math.round(ratio * 100)}<tspan className="studio-ring-percent">%</tspan></text></svg><strong>{label}</strong><span>{display}</span></div>;
}
function RingsWidget(props: WidgetProps) {
  const result = useStudioRows<PackageRow>(props);
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  if (!result.rows.length) return <WidgetEmpty title="No packages in this view">Clear a filter to bring the packages back.</WidgetEmpty>;
  const sum = (key: keyof PackageRow) => result.rows.reduce((total, row) => total + number(row[key]), 0), budget = sum("budgetMinor");
  return <div className="studio-rings-widget"><PackageFilter result={result} count={result.rows.length}/><div className="studio-ring-group">
    <ProgressRing numerator={sum("pledgedMinor")} denominator={budget} color="#4A6FA5" label="Committed" display={studioMoney(sum("pledgedMinor"))}/>
    <ProgressRing numerator={sum("fundingEligibleMinor")} denominator={budget} color="#F2A93B" label="Collected" display={studioMoney(sum("fundingEligibleMinor"))}/>
    <ProgressRing numerator={sum("reviewedItemCount")} denominator={sum("requiredItemCount")} color="#3E8E5E" label="Work accepted" display={`${sum("reviewedItemCount")} / ${sum("requiredItemCount")} items`}/>
  </div><div className="studio-ring-budget"><span>Approved package budgets</span><strong>{studioMoney(budget)}</strong></div><div className="studio-mini-packages">{result.rows.map(row => <button key={row.id} onClick={() => result.select(row.packageId)} aria-pressed={result.selected.has(row.packageId)}><span>{row.shortTitle || row.title}</span><span className="studio-mini-bar"><i style={{ width: `${row.budgetMinor ? Math.min(100, row.fundingEligibleMinor / row.budgetMinor * 100) : 0}%` }}/></span><strong>{Math.round(row.budgetMinor ? row.fundingEligibleMinor / row.budgetMinor * 100 : 0)}%</strong></button>)}</div><div className="studio-distinct-facts"><span><FileCheck2 size={14}/>{studioMoney(sum("approvedExpenseMinor"))} expense review</span><span><Check size={14}/>{studioMoney(sum("paidExpenseMinor"))} delivered</span></div><WidgetNote>Collected includes eligible receipts on both rails, after refund reserves. The evidence ring counts accepted work requirements only.</WidgetNote></div>;
}

function MatrixWidget(props: WidgetProps) {
  const result = useStudioRows<PackageRow>(props);
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  return <div className="studio-matrix-widget"><PackageFilter result={result} count={result.rows.length}/><div className="studio-table-wrap" role="region" aria-label="Package budgets, collections and work evidence" tabIndex={0}><table className="studio-data-table"><thead><tr><th scope="col">Work package</th><th scope="col">Budget</th><th scope="col">Collected</th><th scope="col">Expense review</th><th scope="col">Work proof</th></tr></thead><tbody>{result.rows.map(row => <tr key={row.id} className={result.selected.has(row.packageId) ? "selected" : ""}><th scope="row"><button onClick={() => result.select(row.packageId)} aria-pressed={result.selected.has(row.packageId)}>{row.shortTitle || row.title}<ArrowDownRight size={12}/></button><small>{nice(row.fundingState)}</small></th><td>{studioMoney(row.budgetMinor)}</td><td><strong>{studioMoney(row.collectedMinor)}</strong>{row.shortfallMinor > 0 && <small>{studioMoney(row.shortfallMinor)} to collect</small>}</td><td>{studioMoney(row.approvedExpenseMinor)}<small>{row.reviewedExpenseLineCount} lines reviewed</small></td><td><button className="studio-proof-button" aria-label={`${row.title}: ${row.reviewedItemCount} of ${row.requiredItemCount} work requirements accepted. Open proof details.`} onClick={event => props.context.openDetail({ kind: "package", id: row.id }, event.currentTarget)}>{row.reviewedItemCount} / {row.requiredItemCount}<ArrowUpRight size={12}/></button><small>{nice(row.workState)}</small></td></tr>)}</tbody></table></div>{!result.rows.length && <WidgetEmpty title="No package matches these filters">Clear a filter to see the project’s package position.</WidgetEmpty>}<WidgetNote>Money is counted once per package. A reviewed claim becomes a payable only after its separate approval gates.</WidgetNote></div>;
}

function EvidenceWidget(props: WidgetProps) {
  const result = useStudioRows<EvidenceRow>(props);
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  const packageName = (id: string) => props.context.snapshot.data.packages.find(row => row.id === id)?.shortTitle ?? "Project evidence";
  return <div className="studio-evidence-widget"><PackageFilter result={result} count={result.rows.length}/>{result.rows.length ? <div className="studio-evidence-list">{result.rows.map(row => {
    const isReceipt = row.sourceClass.includes("receipt") || row.sourceClass.includes("claim"), Icon = isReceipt ? FileText : row.sourceClass.includes("photo") ? ImageIcon : ShieldCheck;
    return <button key={row.id} className="studio-evidence-card" onClick={event => props.context.openDetail({ kind: "evidence", id: row.id }, event.currentTarget)}><span className={`studio-evidence-thumbnail ${isReceipt ? "is-receipt" : ""}`}><Icon size={26} strokeWidth={1.2}/><i/><i/></span><span className="studio-evidence-copy"><span className="studio-overline">{packageName(row.packageId)}</span><strong>{row.title}</strong><span>{nice(row.reviewState)}{row.amountMinor != null ? ` · ${studioMoney(row.amountMinor)}` : ""}</span><small>{row.sourceAvailable ? <><FileCheck2 size={11}/>Private original available</> : <><LockKeyhole size={11}/>Scoped summary</>}</small></span><ArrowUpRight size={15}/></button>;
  })}</div> : <WidgetEmpty title="Good work deserves a clear record" icon={FileCheck2}>No evidence is visible in this view yet. Accepted work and permitted receipt reviews appear here with their own scope.</WidgetEmpty>}<WidgetNote>Open a card to see exactly what its review establishes. Source access is checked again on every open.</WidgetNote></div>;
}

function AllocationWidget(props: WidgetProps) {
  const result = useStudioRows<AllocationRow>(props);
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  const current = result.rows.filter(row => row.isCurrent), amount = current.reduce((sum, row) => sum + row.activeAllocationMinor, 0);
  return <div className="studio-allocation-widget"><PackageFilter result={result} count={result.rows.length}/>{result.rows.length ? <><div className="studio-allocation-total"><span>Active receipt allocations</span><strong>{studioMoney(amount)}</strong></div><ol className="studio-allocation-list">{result.rows.map(row => <li key={row.id} className={row.isCurrent ? "" : "is-historical"}><button onClick={event => props.context.openDetail({ kind: "allocation", id: row.id }, event.currentTarget)}><span className="studio-lineage-node"><Link2 size={15}/>{row.sourceKind === "orders_capture" ? "Capture" : "Invoice payment"}<small>Receipt …{row.settlementReceiptId.slice(-6)}</small></span><ArrowRight size={17}/><span className="studio-lineage-node"><FileCheck2 size={15}/>{row.expenseLabel}<small>Revision {row.revision} · {nice(row.state)}</small></span><strong>{studioMoney(row.allocationMinor)}<small>{row.isCurrent ? "Current" : "Historical"}</small></strong><ArrowUpRight size={13}/></button></li>)}</ol></> : <WidgetEmpty title="The trail begins with an approved allocation" icon={Link2}>No receipt has been allocated to an expense in this view. Collection, a reviewed receipt, and a delivered repayment each need their own recorded step.</WidgetEmpty>}<WidgetNote>Only recorded allocation revisions create links here. Earlier and reversed revisions stay visible without increasing the current total.</WidgetNote></div>;
}

function ExceptionsWidget(props: WidgetProps) {
  const result = useStudioRows<ExceptionRow>(props);
  if (!result.valid || result.error || result.loading) return <QueryStatus result={result}/>;
  return <div className="studio-exceptions-widget"><PackageFilter result={result} count={result.rows.length}/>{result.rows.length ? <div className="studio-exception-list">{result.rows.map(row => <button key={row.id} onClick={event => props.context.openDetail({ kind: "exception", id: row.id }, event.currentTarget)}><span className={`studio-exception-icon ${row.severity === "blocked" ? "blocked" : ""}`}><TriangleAlert size={17}/></span><span><strong>{row.title}</strong><span>{row.detail}</span><small>{nice(row.status)} · {row.observedAt ? new Date(row.observedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "No provider observation"}</small></span>{row.affectedMinor > 0 && <b>{studioMoney(row.affectedMinor)}</b>}<ArrowUpRight size={13}/></button>)}</div> : <WidgetEmpty title="Nothing unresolved in this view" icon={ShieldCheck}>No scoped reconciliation exception is recorded at this cutoff. This is not a certification of work or a live provider balance.</WidgetEmpty>}<WidgetNote>These are overlapping review questions, not amounts to add together. No collection or payout runs from this report.</WidgetNote></div>;
}

const components: Record<FieldproofWidgetId, ComponentType<WidgetProps>> = {
  "fieldproof-blueprint": BlueprintWidget, "fieldproof-rings": RingsWidget, "fieldproof-matrix": MatrixWidget,
  "fieldproof-evidence": EvidenceWidget, "fieldproof-allocation": AllocationWidget, "fieldproof-exceptions": ExceptionsWidget,
};
const widgetDescriptions: Record<FieldproofWidgetId, string> = {
  "fieldproof-blueprint": "A warm illustrative room plan. Selecting a package starts a native cross-filter. Geometry is not a surveyed or certified plan.",
  "fieldproof-rings": "Three independent rings for commitments, eligible collection across both rails, and accepted physical work requirements. Reviewed expenses and delivered repayments are displayed separately.",
  "fieldproof-matrix": "A package table with each budget counted once, net collected, reviewed expense lines, funding state, and accepted work requirements. Click the package name to cross-filter or its proof count to drill through.",
  "fieldproof-evidence": "A scoped evidence gallery with actual claim/package review associations and accepted work summaries. Open a card for its review scope and, when permitted, a separately authorized private original.",
  "fieldproof-allocation": "Real receipt-to-claim-line allocation revisions only. Current totals use activeAllocationMinor; historical revisions remain separate. Empty data produces an honest empty state.",
  "fieldproof-exceptions": "Current unresolved collection, refund, and evidence-review issues, with exact observation dates. Affected amounts overlap and cannot be summed as a balance.",
};
export function fieldproofWidgets(): AgWidgetsConfig<FieldproofRegistry> {
  const builtIn = createWidgets({});
  // Reuse the documented built-in grid's format contract for title, appearance and native
  // cross-filter settings. It explicitly retains triggerCrossFilter across state reloads.
  const commonFormatShape = builtIn.widgets.find(widget => widget.id === "grid")!.formatShape!;
  const definitions: FieldproofDefinition[] = STUDIO_WIDGET_IDS.map(id => ({
    id, label: WIDGET_TITLES[id], comp: components[id], formatShape: commonFormatShape,
    icon: { className: "studio-widget-catalog-icon" },
    dataMapping: {
      rows: { type: "field", supportedRoles: ["category"], required: true, aiDescription: `Use ${STUDIO_WIDGET_TABLES[id]}.id without aggregation. This stable identity defines the rows in this widget.` },
      package: { type: "field", supportedRoles: ["category"], required: true, aiDescription: `Use ${STUDIO_WIDGET_TABLES[id]}.packageId without aggregation. This shared package identity drives cross-filtering.` },
    },
    defaultState: { dataMapping: { rows: [{ id: `${STUDIO_WIDGET_TABLES[id]}.id` }], package: [{ id: `${STUDIO_WIDGET_TABLES[id]}.packageId` }] }, format: { title: { enabled: true, text: WIDGET_TITLES[id] }, subtitle: { enabled: false }, caption: { enabled: false }, crossFilter: "filter", triggerCrossFilter: true } },
    form: params => params.createDefaults({ supportsTriggerCrossFilter: true, dataMappingItems: [{ key: "rows", label: "Source row identity" }, { key: "package", label: "Shared package identity" }] }),
    defaultSize: { width: 550, height: 400 }, minSize: { width: 300, height: 240 },
    ai: { label: WIDGET_TITLES[id], description: widgetDescriptions[id], usage: "Use this Fieldproof domain widget for its stated purpose. Its records are already role-redacted. Never infer payment authority or physical completion from the layout.", configuration: `Keep dataMapping.rows=[{id:'${STUDIO_WIDGET_TABLES[id]}.id'}] and dataMapping.package=[{id:'${STUDIO_WIDGET_TABLES[id]}.packageId'}]. Format supports title/subtitle/caption and crossFilter/triggerCrossFilter; preserve financial minor units.` },
  }));
  const all = createWidgets<FieldproofRegistry>({ additionalTypes: definitions, menu: [{ label: "Fieldproof · a connected record", widgetIds: STUDIO_WIDGET_IDS }, { label: "Explore the scoped data", widgetIds: ["grid", "value"] }], defaultType: "grid" });
  return { ...all, widgets: all.widgets.filter(widget => [...STUDIO_WIDGET_IDS, "grid", "value"].includes(widget.id)) };
}
