/** Fixed eight-decimal arithmetic. Money is rounded half away from zero only at posting boundaries. */
export const SCALE = 100000000n;
export function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,12}(\.\d{1,8})?$/.test(value)) throw new Error('Expected a decimal string with at most eight decimal places');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'))) * (negative ? -1n : 1n);
}
export const divide = (a: bigint, b: bigint) => { if (b === 0n) throw new Error('Division by zero'); const sign=(a<0n)!==(b<0n)?-1n:1n; const x=a<0n?-a:a,y=b<0n?-b:b; return sign*((x+y/2n)/y); };
export const multiply = (a: bigint, b: bigint) => divide(a*b,SCALE);
export const minimum = (balance: bigint) => balance<=0n?0n:balance<100n*SCALE?balance:balance/10n>100n*SCALE?divide(balance,10n):100n*SCALE;
export const pennies = (value: bigint) => divide(value,1000000n)*1000000n;
export const format = (value: bigint) => { const cents=divide(value,1000000n),a=cents<0n?-cents:cents;return `${cents<0n?'-':''}${a/100n}.${String(a%100n).padStart(2,'0')}`; };
export const max = (a: bigint,b: bigint) => a>b?a:b;
export const min = (a: bigint,b: bigint) => a<b?a:b;
