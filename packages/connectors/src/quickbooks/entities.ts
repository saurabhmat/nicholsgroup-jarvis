// QuickBooks entity projections (T-051): every entity read from Intuit is cut down to a STRICT allowlist of fields
// before it becomes a raw record (T-039 review: the raw key guards are only a backstop). Zod objects below strip every
// key they do not name, at every level, so a new or unexpected Intuit field is never stored.
// Deliberately NOT kept anywhere: `CustomField` arrays (the field name travels as a value, so a field called "Bank
// account" would slip past the key guards), account / routing / tax-id numbers (`AcctNum`, `BankAccountNum`,
// `PrimaryTaxIdentifier`, `TaxIdentifier`...), e-mail / phone / address blocks, memos and descriptions (`PrivateNote`,
// `Description`, `CustomerMemo`), payment reference and check numbers, and all sales-tax detail (`TxnTaxDetail`,
// `TaxCodeRef`). Nothing downstream depends on multicurrency or sales-tax fields: `CurrencyRef`/`ExchangeRate` are kept
// when present and are optional, tax detail is never read.
// Rule 7 / 8: figures stay as Intuit sent them; T-056 normalises them into fin.* with SQL. Book balances are book
// balances: `CurrentBalance` is the account's QuickBooks book balance, nothing here is a bank balance.
import { z } from "zod";

/** Entities synced by query / CDC, in load order. Singletons (CompanyInfo, Preferences) are handled separately. */
export const QBO_SYNC_ENTITIES = ["Account", "Class", "Customer", "Vendor", "Invoice", "Payment", "Bill", "BillPayment", "Purchase", "Deposit", "JournalEntry"] as const;
export type QboEntity = (typeof QBO_SYNC_ENTITIES)[number];
export const QBO_SINGLETONS = ["CompanyInfo", "Preferences"] as const;
export type QboSingleton = (typeof QBO_SINGLETONS)[number];
export const QBO_OBJECT_TYPES: readonly string[] = [...QBO_SYNC_ENTITIES, ...QBO_SINGLETONS];

/** Entities Intuit hides when inactive unless the query says otherwise (`Active in (true, false)`). */
export const QBO_HAS_ACTIVE_FLAG: ReadonlySet<string> = new Set(["Account", "Class", "Customer", "Vendor"]);

const Str = (max = 256) => z.string().max(max);
/**
 * Free text can carry an account number: "Operating Checking 123456789" (T-051 security M1). Any run of `min`+ digits
 * (Unicode digits, after NFKC, with up to two non-letter separators between digits) is masked. Names use 5 (the same
 * rule as T-055/T-056 for fin.* names); document numbers use 8, which keeps INV-100234 and masks a 16-digit number.
 */
export function maskDigitRuns(text: string, min = 5): string {
  return text.normalize("NFKC").replace(new RegExp(`\\p{Nd}(?:[^\\p{L}\\p{Nd}]{0,2}\\p{Nd}){${min - 1},}`, "gu"), "[masked]");
}
const Name = (max = 256) => z.string().max(max).transform((t) => maskDigitRuns(t, 5));
const DocNo = z.string().max(64).transform((t) => maskDigitRuns(t, 8));
// The raw guard scans keys up to 16 levels deep (raw/guard.ts MAX_DEPTH): the deepest kept path here (Line[] > detail >
// Entity > EntityRef > value) is 6 levels, so it must stay far below that.
const Id = Str(64);
/** `{ value }` only: the reference's `name` is not kept. */
const Ref = z.object({ value: Id }).optional();
const Meta = z.object({ CreateTime: Str(40).optional(), LastUpdatedTime: Str(40).optional() }).optional();
/** Customer or Vendor only; anything else (Employee, other names) is excluded before the schema sees it. */
const EntityTypeRef = z.object({ value: Id, type: z.enum(["Customer", "Vendor"]).optional() }).optional();
const Money = z.number().finite().optional();

const LinkedTxn = z.array(z.object({ TxnId: Id, TxnType: Str(40) })).max(200).optional();

// Line detail blocks keep references and the posting type only (class, account, item, department, entity).
const LineDetail = z
  .object({
    ClassRef: Ref,
    AccountRef: Ref,
    ItemRef: Ref,
    DepartmentRef: Ref,
    PostingType: Str(16).optional(),
    // Customer or Vendor only: a transaction that names an Employee never gets this far (see refersToEmployee).
    Entity: z.object({ Type: z.enum(["Customer", "Vendor"]).optional(), EntityRef: EntityTypeRef }).optional(),
  })
  .optional();

const Line = z.object({
  Id: Id.optional(),
  LineNum: z.number().int().optional(),
  Amount: Money,
  DetailType: Str(64).optional(),
  SalesItemLineDetail: LineDetail,
  AccountBasedExpenseLineDetail: LineDetail,
  ItemBasedExpenseLineDetail: LineDetail,
  DepositLineDetail: LineDetail,
  JournalEntryLineDetail: LineDetail,
  LinkedTxn,
});
const Lines = z.array(Line).max(2000).optional();

const Common = { Id, MetaData: Meta };
const Currency = { CurrencyRef: Ref, ExchangeRate: z.number().finite().optional() };

export const ENTITY_SCHEMAS = {
  Account: z.object({
    ...Common,
    Name: Name(256).optional(),
    FullyQualifiedName: Name(512).optional(),
    Active: z.boolean().optional(),
    AccountType: Str(64).optional(),
    AccountSubType: Str(64).optional(),
    Classification: Str(32).optional(),
    SubAccount: z.boolean().optional(),
    ParentRef: Ref,
    CurrentBalance: Money,
    CurrentBalanceWithSubAccounts: Money,
    CurrencyRef: Ref,
  }),
  Class: z.object({ ...Common, Name: Name(256).optional(), FullyQualifiedName: Name(512).optional(), Active: z.boolean().optional(), SubClass: z.boolean().optional(), ParentRef: Ref }),
  Customer: z.object({
    ...Common,
    DisplayName: Name(256).optional(),
    Active: z.boolean().optional(),
    Job: z.boolean().optional(),
    ParentRef: Ref,
    Balance: Money,
    BalanceWithJobs: Money,
    CurrencyRef: Ref,
  }),
  Vendor: z.object({ ...Common, DisplayName: Name(256).optional(), Active: z.boolean().optional(), Vendor1099: z.boolean().optional(), Balance: Money, CurrencyRef: Ref }),
  Invoice: z.object({
    ...Common,
    DocNumber: DocNo.optional(),
    TxnDate: Str(16).optional(),
    DueDate: Str(16).optional(),
    TotalAmt: Money,
    Balance: Money,
    CustomerRef: Ref,
    ClassRef: Ref,
    DepartmentRef: Ref,
    ...Currency,
    Line: Lines,
    LinkedTxn,
  }),
  Payment: z.object({
    ...Common,
    TxnDate: Str(16).optional(),
    TotalAmt: Money,
    UnappliedAmt: Money,
    CustomerRef: Ref,
    DepositToAccountRef: Ref,
    ...Currency,
    Line: Lines,
  }),
  Bill: z.object({
    ...Common,
    DocNumber: DocNo.optional(),
    TxnDate: Str(16).optional(),
    DueDate: Str(16).optional(),
    TotalAmt: Money,
    Balance: Money,
    VendorRef: Ref,
    APAccountRef: Ref,
    ClassRef: Ref,
    DepartmentRef: Ref,
    ...Currency,
    Line: Lines,
    LinkedTxn,
  }),
  BillPayment: z.object({
    ...Common,
    TxnDate: Str(16).optional(),
    TotalAmt: Money,
    PayType: Str(32).optional(),
    VendorRef: Ref,
    APAccountRef: Ref,
    // Account references only; never the check number or any account number.
    CheckPayment: z.object({ BankAccountRef: Ref }).optional(),
    CreditCardPayment: z.object({ CCAccountRef: Ref }).optional(),
    ...Currency,
    Line: Lines,
  }),
  Purchase: z.object({
    ...Common,
    TxnDate: Str(16).optional(),
    TotalAmt: Money,
    PaymentType: Str(32).optional(),
    // True for a card credit / refund: the normalizer (T-056) flips the posting signs. Unverified against Intuit (H-034).
    Credit: z.boolean().optional(),
    AccountRef: Ref,
    EntityRef: EntityTypeRef,
    DepartmentRef: Ref,
    ...Currency,
    Line: Lines,
  }),
  Deposit: z.object({ ...Common, TxnDate: Str(16).optional(), TotalAmt: Money, DepositToAccountRef: Ref, DepartmentRef: Ref, ...Currency, Line: Lines }),
  JournalEntry: z.object({ ...Common, DocNumber: DocNo.optional(), TxnDate: Str(16).optional(), Adjustment: z.boolean().optional(), TotalAmt: Money, ...Currency, Line: Lines }),
} satisfies Record<QboEntity, z.ZodType>;

/** Preferences: report basis, fiscal-year start and the three edition flags; everything else (company e-mail, address, templates...) is dropped. */
export const PreferencesSchema = z.object({
  Id: Id.optional(),
  MetaData: Meta,
  AccountingInfoPrefs: z
    .object({
      FirstMonthOfFiscalYear: Str(32).optional(),
      TrackDepartments: z.boolean().optional(),
      ClassTrackingPerTxn: z.boolean().optional(),
      ClassTrackingPerTxnLine: z.boolean().optional(),
    })
    .optional(),
  CurrencyPrefs: z.object({ MultiCurrencyEnabled: z.boolean().optional(), HomeCurrency: Ref }).optional(),
  ReportPrefs: z.object({ ReportBasis: Str(32).optional() }).optional(),
});

export const CompanyInfoSchema = z.object({
  Id,
  MetaData: Meta,
  CompanyName: Name(256).optional(),
  LegalName: Name(256).optional(),
  Country: Str(64).optional(),
  FiscalYearStartMonth: Str(32).optional(),
  CompanyStartDate: Str(32).optional(),
});

export type QboFeatures = { class_tracking: boolean; location_tracking: boolean; multicurrency: boolean };

/** Edition flags from Preferences. A missing block counts as off; nothing else depends on them. */
export function featuresFromPreferences(prefs: z.infer<typeof PreferencesSchema>): QboFeatures {
  const a = prefs.AccountingInfoPrefs;
  return {
    class_tracking: a?.ClassTrackingPerTxn === true || a?.ClassTrackingPerTxnLine === true,
    location_tracking: a?.TrackDepartments === true,
    multicurrency: prefs.CurrencyPrefs?.MultiCurrencyEnabled === true,
  };
}

/** Intuit's `2026-10-28T09:13:25-07:00` form is accepted by the raw store; anything else becomes null (never guessed). */
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:?[0-9]{2})$/;
export function sourceUpdatedAt(meta: { LastUpdatedTime?: string | undefined } | undefined): string | null {
  const t = meta?.LastUpdatedTime;
  return t !== undefined && INSTANT.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
}

export type ProjectedRecord = { objectType: string; externalId: string; payload: Record<string, unknown>; sourceUpdatedAt: string | null; deleted: boolean };

/** Voided transactions keep their Id with `PrivateNote: "Voided"` and zero amounts; only that exact marker becomes a flag. */
function voidedFlag(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as { PrivateNote?: unknown }).PrivateNote === "Voided";
}

export type ExclusionReason = "employee" | "payroll" | "entity";
export type ExclusionPolicy = {
  /** QuickBooks Account Ids classified as payroll for this run (see classifyPayrollAccounts). */
  payrollAccountIds: ReadonlySet<string>;
  /** Customer / vendor Ids from `lane_config.finance.payroll.excluded_entity_ids` (people paid as vendors), treated like employees. */
  excludedEntityIds: ReadonlySet<string>;
};

const lc = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const valueOf = (v: unknown): string | null => (typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "string" ? (v as { value: string }).value : null);
const PAYROLL_NAME = /payroll|salar(?:y|ies)|\bwages?\b|compensation/i;
/** The name safety net of the payroll classification, for report labels (T-052). */
export const isPayrollLabel = (text: string): boolean => PAYROLL_NAME.test(text);

/**
 * Accounts that are payroll for this run (D-25: payroll is excluded entirely): the configured ids, every account whose
 * AccountSubType is a configured payroll subtype (Intuit's enum, default list in lane_config), a safety net on the
 * name ("payroll", "salary", "wages", "compensation"), and sub-accounts of any of those (repeated until stable).
 */
export function classifyPayrollAccounts(accounts: readonly unknown[], settings: { accountIds: readonly string[]; accountSubtypes: readonly string[] }): Set<string> {
  const subtypes = new Set(settings.accountSubtypes.map(lc));
  const ids = new Set(settings.accountIds);
  const parents = new Map<string, string>();
  for (const a of accounts) {
    const o = a as { Id?: unknown; AccountSubType?: unknown; Name?: unknown; FullyQualifiedName?: unknown; ParentRef?: unknown };
    if (typeof o?.Id !== "string") continue;
    if (subtypes.has(lc(o.AccountSubType)) || PAYROLL_NAME.test(String(o.Name ?? "")) || PAYROLL_NAME.test(String(o.FullyQualifiedName ?? ""))) ids.add(o.Id);
    const parent = valueOf(o.ParentRef);
    if (parent) parents.set(o.Id, parent);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, parent] of parents) if (!ids.has(id) && ids.has(parent)) { ids.add(id); grew = true; }
  }
  return ids;
}

/**
 * Why this object must not be stored, or null. Scans the WHOLE raw object (any depth up to 12; deeper fails closed):
 *  - "employee": any `type`/`Type` equal to Employee (case-insensitive), a key starting with "Employee", or an
 *    Entity/EntityRef whose type is not Customer or Vendor (other people);
 *  - "payroll": any `*AccountRef` (header or line) pointing at a payroll account, or the account itself;
 *  - "entity": a reference to a configured excluded customer/vendor id, or that customer/vendor itself.
 * The whole transaction is excluded, never only the line: its TotalAmt would leak the amount.
 */
export function exclusionReason(entity: QboEntity, raw: unknown, policy: ExclusionPolicy): ExclusionReason | null {
  const id = (raw as { Id?: unknown } | null)?.Id;
  if (entity === "Account" && typeof id === "string" && policy.payrollAccountIds.has(id)) return "payroll";
  if ((entity === "Vendor" || entity === "Customer") && typeof id === "string" && policy.excludedEntityIds.has(id)) return "entity";
  let found: ExclusionReason | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (found || node === null || typeof node !== "object") return;
    if (depth > 12) { found = "employee"; return; }
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      if ((k === "type" || k === "Type") && lc(v) === "employee") { found = "employee"; return; }
      if (/^employee/i.test(k)) { found = "employee"; return; }
      if ((k === "Entity" || k === "EntityRef") && typeof v === "object" && v !== null) {
        const t = (v as { type?: unknown; Type?: unknown }).type ?? (v as { Type?: unknown }).Type;
        if (typeof t === "string" && !["customer", "vendor"].includes(lc(t))) { found = "employee"; return; }
      }
      if (/AccountRef$/i.test(k)) {
        const ref = valueOf(v);
        if (ref !== null && policy.payrollAccountIds.has(ref)) { found = "payroll"; return; }
      }
      if (/^(Entity|Vendor|Customer)Ref$/.test(k)) {
        const ref = valueOf(v);
        if (ref !== null && policy.excludedEntityIds.has(ref)) { found = "entity"; return; }
      }
      walk(v, depth + 1);
    }
  };
  walk(raw, 0);
  return found;
}

/** An excluded object becomes a tombstone (`deleted`, Id only, its own update time) so an earlier stored version cannot stay live. */
export function projectTombstone(entity: QboEntity, raw: unknown): ProjectedRecord | null {
  return projectDeleted(entity, raw);
}

/** Projects one object to its allowlist, or returns null when it has no usable Id or does not fit (never stored half-checked). */
export function projectEntity(entity: QboEntity, raw: unknown): ProjectedRecord | null {
  // A live object has no `status` (a deleted one is `status: "Deleted"` and goes through projectDeleted). Anything else
  // means the shape is not what we think it is: refuse rather than store an empty stub as a live record.
  if (typeof raw === "object" && raw !== null && "status" in raw) return null;
  const parsed = ENTITY_SCHEMAS[entity].safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data as Record<string, unknown> & { Id: string; MetaData?: { LastUpdatedTime?: string } };
  const payload: Record<string, unknown> = { ...data };
  if (entity === "Invoice" || entity === "Bill" || entity === "Payment" || entity === "BillPayment" || entity === "Purchase" || entity === "Deposit" || entity === "JournalEntry") {
    if (voidedFlag(raw)) payload.Voided = true;
  }
  return { objectType: entity, externalId: data.Id, payload, sourceUpdatedAt: sourceUpdatedAt(data.MetaData), deleted: false };
}

/** A CDC deletion carries the Id (and maybe MetaData); the record is just the Id, flagged deleted. */
export function projectDeleted(entity: QboEntity, raw: unknown): ProjectedRecord | null {
  const parsed = z.object({ Id, MetaData: Meta }).safeParse(raw);
  if (!parsed.success) return null;
  return { objectType: entity, externalId: parsed.data.Id, payload: { Id: parsed.data.Id }, sourceUpdatedAt: sourceUpdatedAt(parsed.data.MetaData), deleted: true };
}

export function projectPreferences(raw: unknown, realm: string): { record: ProjectedRecord; features: QboFeatures } | null {
  const parsed = PreferencesSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Preferences are one object per company: the realm is its id (Intuit's own Id is "0").
  const payload: Record<string, unknown> = { ...parsed.data, Id: realm };
  return { record: { objectType: "Preferences", externalId: realm, payload, sourceUpdatedAt: sourceUpdatedAt(parsed.data.MetaData), deleted: false }, features: featuresFromPreferences(parsed.data) };
}

export function projectCompanyInfo(raw: unknown, realm: string): ProjectedRecord | null {
  const parsed = CompanyInfoSchema.safeParse(raw);
  if (!parsed.success || parsed.data.Id !== realm) return null;
  return { objectType: "CompanyInfo", externalId: realm, payload: { ...parsed.data }, sourceUpdatedAt: sourceUpdatedAt(parsed.data.MetaData), deleted: false };
}
