// Simple filter to remove alcohol particles from breath sample
export function filterBreathSample(sample: string): string {
  // Remove alcohol particles using a simple filter
  return sample.replace(/alcohol|ethanol|isopropyl|methanol/g, '');
}