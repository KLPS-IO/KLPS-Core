export type NormalizedBankEvent={sourceRecordId:string;providerTransactionId:string|null;bookingDate:string;occurredAt:string|null;amount:string;currency:string;direction:'credit'|'debit';merchantName:string|null;reference:string|null;description:string|null;providerCategory:string|null;providerCode:string|null;metadata:Record<string,string>};
export interface BankImportAdapter {
 readonly provider:string; readonly version:string;
 parse(file:Buffer):NormalizedBankEvent[];
}
// Capital on Tap intentionally has no parser: an actual export fixture is required.
export const unsupportedCapitalOnTap=()=>{throw Object.assign(new Error('Capital on Tap CSV format is not yet evidenced. Supply a real export before enabling an adapter.'),{statusCode:422});};
