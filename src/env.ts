/** Reads `SKULK_<name>`, falling back to the pre-rename `WAKE_<name>`. */
export const env = (name: string): string | undefined => process.env[`SKULK_${name}`] ?? process.env[`WAKE_${name}`]
