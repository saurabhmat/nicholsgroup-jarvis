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
