// Synthetic QuickBooks entities for the T-051 sync tests (rule 10: invented data only; the numbers below are not real
// account numbers). Every object carries the kinds of fields the connector must NOT keep (account numbers, custom
// fields, contact blocks, memos, tax detail) so the allowlist tests have something to strip.
export type FakeObject = Record<string, unknown>;

export const SYNTHETIC_BANK_NUMBER = "000123456789";
export const SYNTHETIC_ROUTING = "021000021";
export const SYNTHETIC_EMAIL = "synthetic.person@example.test";

const meta = (at: string) => ({ CreateTime: at, LastUpdatedTime: at });
const ref = (value: string, name = `Synthetic ${value}`) => ({ value, name });
const hazards = {
  AcctNum: SYNTHETIC_BANK_NUMBER,
  BankAccountNum: SYNTHETIC_BANK_NUMBER,
  RoutingNum: SYNTHETIC_ROUTING,
  CustomField: [{ DefinitionId: "1", Name: "Bank account", Type: "StringType", StringValue: SYNTHETIC_BANK_NUMBER }],
  PrivateNote: "synthetic private note",
  PrimaryEmailAddr: { Address: SYNTHETIC_EMAIL },
  PrimaryPhone: { FreeFormNumber: "555-0100" },
  BillAddr: { Line1: "1 Synthetic Way", City: "Testville" },
  TxnTaxDetail: { TotalTax: 12.5, TaxLine: [{ Amount: 12.5 }] },
};

export type FakeData = Record<string, FakeObject[]>;

/** `n` objects per entity with Ids 1..n, last updated `2026-10-01T10:00:00-04:00` plus the index in minutes. */
export function syntheticData(n = 2, at = "2026-10-01"): FakeData {
  const t = (i: number) => `${at}T10:${String(i).padStart(2, "0")}:00-04:00`;
  const make = (i: number, entity: string): FakeObject => {
    const id = String(i);
    const base = { Id: id, SyncToken: "0", MetaData: meta(t(i)), ...hazards };
    const line = (amount: number) => ({
      Id: "1",
      LineNum: 1,
      Amount: amount,
      Description: "synthetic line description",
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: { ItemRef: ref("7"), ClassRef: ref("2"), TaxCodeRef: { value: "TAX" }, Qty: 1, UnitPrice: amount },
    });
    switch (entity) {
      case "Account":
        return { ...base, Name: `Synthetic Account ${id}`, FullyQualifiedName: `Synthetic Account ${id}`, Active: true, AccountType: "Bank", AccountSubType: "Checking", Classification: "Asset", CurrentBalance: 1000.5 * i, CurrencyRef: ref("USD") };
      case "Class":
        return { ...base, Name: `Synthetic Class ${id}`, FullyQualifiedName: `Synthetic Class ${id}`, Active: true, SubClass: false };
      case "Customer":
        return { ...base, DisplayName: `Synthetic Customer ${id}`, GivenName: "Synthia", FamilyName: "Test", Active: true, Balance: 10 * i, PrimaryTaxIdentifier: "XXX-SYNTH" };
      case "Vendor":
        return { ...base, DisplayName: `Synthetic Vendor ${id}`, Active: true, Balance: 5 * i, Vendor1099: false, TaxIdentifier: "XXX-SYNTH", BillRate: 55 };
      case "Invoice":
        return { ...base, DocNumber: `INV-${id}`, TxnDate: "2026-09-15", DueDate: "2026-10-15", TotalAmt: 112.5 * i, Balance: 112.5, CustomerRef: ref("1"), CurrencyRef: ref("USD"), CustomerMemo: { value: "synthetic memo" }, Line: [line(100 * i)], LinkedTxn: [{ TxnId: "9", TxnType: "Payment" }] };
      case "Payment":
        return { ...base, TxnDate: "2026-09-20", TotalAmt: 50, UnappliedAmt: 0, CustomerRef: ref("1"), DepositToAccountRef: ref("1"), PaymentRefNum: "CHK-998877", Line: [{ Amount: 50, LinkedTxn: [{ TxnId: "1", TxnType: "Invoice" }] }] };
      case "Bill":
        return { ...base, DocNumber: `BILL-${id}`, TxnDate: "2026-09-10", DueDate: "2026-10-10", TotalAmt: 300, Balance: 300, VendorRef: ref("1"), APAccountRef: ref("33"), Line: [{ Id: "1", Amount: 300, DetailType: "AccountBasedExpenseLineDetail", Description: "synthetic", AccountBasedExpenseLineDetail: { AccountRef: ref("40"), ClassRef: ref("2"), BillableStatus: "NotBillable" } }] };
      case "BillPayment":
        return { ...base, TxnDate: "2026-09-25", TotalAmt: 300, PayType: "Check", VendorRef: ref("1"), CheckPayment: { BankAccountRef: ref("1"), PrintStatus: "NotSet", CheckNum: "1042" }, Line: [{ Amount: 300, LinkedTxn: [{ TxnId: "1", TxnType: "Bill" }] }] };
      case "Purchase":
        return { ...base, TxnDate: "2026-09-12", TotalAmt: 80, PaymentType: "Cash", AccountRef: ref("1"), EntityRef: ref("1"), DocNumber: "5001", Line: [{ Id: "1", Amount: 80, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: ref("41"), ClassRef: ref("3") } }] };
      case "Deposit":
        return { ...base, TxnDate: "2026-09-30", TotalAmt: 500, DepositToAccountRef: ref("1"), Line: [{ Amount: 500, DetailType: "DepositLineDetail", DepositLineDetail: { AccountRef: ref("50"), ClassRef: ref("2"), CheckNum: "77", PaymentMethodRef: ref("1") } }] };
      case "JournalEntry":
        return { ...base, DocNumber: `JE-${id}`, TxnDate: "2026-09-30", Adjustment: false, TotalAmt: 20, Line: [{ Id: "0", Amount: 20, DetailType: "JournalEntryLineDetail", Description: "synthetic", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: ref("40"), ClassRef: ref("2"), Entity: { Type: "Vendor", EntityRef: ref("1") } } }] };
      default:
        throw new Error(`unknown synthetic entity ${entity}`);
    }
  };
  const entities = ["Account", "Class", "Customer", "Vendor", "Invoice", "Payment", "Bill", "BillPayment", "Purchase", "Deposit", "JournalEntry"];
  return Object.fromEntries(entities.map((e) => [e, Array.from({ length: n }, (_v, i) => make(i + 1, e))]));
}

export type FakePreferences = { classTracking?: boolean; classPerLine?: boolean; departments?: boolean; multicurrency?: boolean };

export function syntheticPreferences(p: FakePreferences = {}): FakeObject {
  return {
    Id: "1",
    SyncToken: "3",
    MetaData: meta("2026-08-01T09:00:00-04:00"),
    AccountingInfoPrefs: { FirstMonthOfFiscalYear: "January", TrackDepartments: p.departments ?? false, ClassTrackingPerTxn: p.classTracking ?? false, ClassTrackingPerTxnLine: p.classPerLine ?? false, CustomerTerminology: "Customers", DepartmentTerminology: "Location" },
    CurrencyPrefs: { MultiCurrencyEnabled: p.multicurrency ?? false, HomeCurrency: { value: "USD" } },
    ReportPrefs: { ReportBasis: "Accrual", CalcAgingReportFromTxnDate: false },
    SalesFormsPrefs: { DefaultTerms: "3", CustomField: [{ Name: "Bank account", StringValue: SYNTHETIC_BANK_NUMBER }] },
    TaxPrefs: { UsingSalesTax: false },
    EmailMessagesPrefs: { InvoiceMessage: { Subject: "synthetic subject" } },
  };
}

// ------------------------------------------------------------------------------------------------ reports (T-052)
// Synthetic QuickBooks report answers in Intuit's shape (Header / Columns / Rows with nested sections). They carry what
// the projection must drop: Option lists, column MetaData, `href` links, row-level memo-like keys, and label text with
// account numbers. Invented values only (rule 10); the shape is from Intuit's documentation, unverified against the live
// service (H-035).
export type FakeReports = Record<string, FakeObject>;

const cd = (value: string, id?: string, extra: FakeObject = {}) => ({ value, ...(id ? { id } : {}), ...extra });
const dataRow = (label: string, id: string | undefined, ...figures: string[]) => ({ type: "Data", ColData: [cd(label, id, id ? { href: `https://example.test/account/${id}` } : {}), ...figures.map((f) => cd(f))], Memo: "synthetic memo" });
const section = (group: string, title: string, id: string | undefined, rows: unknown[], total: string[]) => ({
  type: "Section",
  group,
  Header: { ColData: [cd(title, id), ...total.map(() => cd(""))] },
  Rows: { Row: rows },
  Summary: { ColData: [cd(`Total ${title}`), ...total.map((t) => cd(t))] },
});
/** When the fake "produced" its reports: ten minutes ago, so it is never later than a test's own clock. */
const reportHeader = (time: string, name: string, basis: string | null, extra: FakeObject = {}) => ({
  Time: time,
  ReportName: name,
  ...(basis ? { ReportBasis: basis } : {}),
  StartPeriod: "2026-01-01",
  EndPeriod: "2026-11-06",
  SummarizeColumnsBy: "Total",
  Currency: "USD",
  Option: [{ Name: "NoReportData", Value: "false" }, { Name: "AccountingStandard", Value: "GAAP" }],
  ...extra,
});
const accountColumns = [
  { ColTitle: "", ColType: "Account", MetaData: [{ Name: "ColKey", Value: "account" }] },
  { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
];
const agingColumns = ["", "Current", "1 - 30", "31 - 60", "61 - 90", "91 and over", "Total"].map((t, i) => ({ ColTitle: t, ColType: i === 0 ? "Customer" : "Money", MetaData: [{ Name: "ColKey", Value: `c${String(i)}` }] }));

/** Ids the report fixtures use: payroll accounts 60 (Payroll Expenses, subtype PayrollExpenses), 61 (its sub-account), 62 (a payroll-named account with no id match). */
export const REPORT_PAYROLL_ACCOUNT_IDS = ["60", "61"] as const;

/** The Account list matching the report fixtures (used for the payroll classification). */
export function syntheticReportAccounts(): FakeObject[] {
  const a = (Id: string, Name: string, AccountType: string, AccountSubType: string, ParentRef?: string): FakeObject => ({
    Id, SyncToken: "0", MetaData: meta("2026-10-01T10:00:00-04:00"), Name, FullyQualifiedName: Name, Active: true, AccountType, AccountSubType, Classification: "Expense", ...(ParentRef ? { SubAccount: true, ParentRef: { value: ParentRef } } : {}),
  });
  return [
    a("1", "Operating Checking", "Bank", "Checking"), a("41", "Subscription Income", "Income", "ServiceFeeIncome"), a("50", "Office Supplies", "Expense", "OfficeGeneralAdministrativeExpenses"),
    a("60", "Team Costs", "Expense", "PayrollExpenses"), a("61", "Team Costs Adjustments", "Expense", "OtherMiscellaneousServiceCost", "60"),
  ];
}

export function syntheticReports(time: string = new Date(Date.now() - 600_000).toISOString().replace(/\.\d{3}Z$/, "Z")): FakeReports {
  const header = (name: string, basis: string | null, extra: FakeObject = {}) => reportHeader(time, name, basis, extra);
  const pnl = {
    Header: header("ProfitAndLoss", "Accrual"),
    Columns: { Column: accountColumns },
    Rows: {
      Row: [
        section("Income", "Income", undefined, [dataRow("Subscription Income", "41", "152000.50")], ["152000.50"]),
        section(
          "Expenses",
          "Expenses",
          undefined,
          [
            dataRow("Office Supplies", "50", "1200.00"),
            dataRow("Operating Checking 123456789 fees", "70", "12.00"),
            // A payroll section: header Id is a payroll account (subtype PayrollExpenses), its child is a sub-account.
            section("PayrollExpenses", "Team Costs", "60", [dataRow("Team Costs Adjustments", "61", "9000.00"), dataRow("Base Costs", "60", "30000.00")], ["39000.00"]),
            // A payroll-named row whose id is unknown: removed by the name safety net.
            dataRow("Salaries and Wages", "99", "500.00"),
          ],
          ["40712.00"],
        ),
        { type: "Section", group: "NetIncome", Summary: { ColData: [cd("Net Income"), cd("111288.50")] } },
      ],
    },
  };

  // Five levels of nested sections: raw JSON depth > 16 (3 levels per section), which the database payload guard refuses.
  const bs = {
    Header: header("BalanceSheet", "Accrual", { StartPeriod: "2026-11-06" }),
    Columns: { Column: accountColumns },
    Rows: {
      Row: [
        section(
          "Assets",
          "ASSETS",
          undefined,
          [
            section(
              "CurrentAssets",
              "Current Assets",
              undefined,
              [
                section(
                  "BankAccounts",
                  "Bank Accounts",
                  undefined,
                  [
                    dataRow("Operating Checking", "1", "84210.55"),
                    section("", "Reserve Account", "2", [dataRow("Reserve Sub-account", "3", "10000.00")], ["10000.00"]),
                  ],
                  ["94210.55"],
                ),
                section("AR", "Accounts Receivable", undefined, [dataRow("Accounts Receivable (A/R)", "4", "18400.00")], ["18400.00"]),
              ],
              ["112610.55"],
            ),
          ],
          ["112610.55"],
        ),
        section("Liabilities", "LIABILITIES AND EQUITY", undefined, [section("CurrentLiabilities", "Current Liabilities", undefined, [dataRow("Accounts Payable (A/P)", "5", "6200.00")], ["6200.00"])], ["6200.00"]),
      ],
    },
  };

  const cashFlow = {
    Header: header("CashFlow", null),
    Columns: { Column: accountColumns },
    Rows: {
      Row: [
        section("OperatingActivities", "OPERATING ACTIVITIES", undefined, [dataRow("Net Income", undefined, "111288.50"), dataRow("Accounts Receivable (A/R)", "4", "-1200.00")], ["110088.50"]),
        { type: "Section", group: "CashAtEndOfPeriod", Summary: { ColData: [cd("CASH AT END OF PERIOD"), cd("94210.55")] } },
      ],
    },
  };

  const aging = (name: string, who: string, ids: [string, string]) => ({
    Header: header(name, null, { StartPeriod: undefined }),
    Columns: { Column: agingColumns },
    Rows: {
      Row: [
        { type: "Data", ColData: [cd(`${who} A 100234 Holdings`, ids[0]), cd("100.00"), cd("0.00"), cd("0.00"), cd("0.00"), cd("0.00"), cd("100.00")] },
        { type: "Data", ColData: [cd(`${who} B`, ids[1]), cd("0.00"), cd("40.00"), cd("0.00"), cd("0.00"), cd("0.00"), cd("40.00")] },
        // A parent with a sub-customer (job): the parent's name is the section header and "Total <name>".
        {
          type: "Section",
          Header: { ColData: [cd(`${who} C 555555 Parent`, "3"), cd(""), cd(""), cd(""), cd(""), cd(""), cd("")] },
          Rows: { Row: [{ type: "Data", ColData: [cd(`${who} C Job Alpha`, "4"), cd("0.00"), cd("0.00"), cd("25.00"), cd("0.00"), cd("0.00"), cd("25.00")] }] },
          Summary: { ColData: [cd(`Total ${who} C 555555 Parent`), cd("0.00"), cd("0.00"), cd("25.00"), cd("0.00"), cd("0.00"), cd("25.00")] },
        },
        { type: "Section", group: "GrandTotal", Summary: { ColData: [cd("TOTAL"), cd("100.00"), cd("40.00"), cd("25.00"), cd("0.00"), cd("0.00"), cd("165.00")] } },
      ],
    },
  });

  return {
    ProfitAndLoss: pnl,
    BalanceSheet: bs,
    CashFlow: cashFlow,
    AgedReceivables: aging("AgedReceivables", "Customer", ["11", "12"]),
    AgedPayables: aging("AgedPayables", "Vendor", ["1", "2"]),
  };
}
