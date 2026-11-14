export const now = (): string => new Date().toISOString();
export const plusMs = (ms: number, from: Date | number = Date.now()): string => new Date(new Date(from).getTime() + ms).toISOString();
export const plusMinutes = (m: number): string => plusMs(m * 60_000);
export const plusDays = (d: number): string => plusMs(d * 86_400_000);
export const isPast = (iso: string | null | undefined): boolean => !!iso && new Date(iso).getTime() <= Date.now();
export const secondsBetween = (a: string, b: string): number =>
  Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
