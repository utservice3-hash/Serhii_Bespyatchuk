import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  kommo: {
    baseUrl: required("KOMMO_BASE_URL"),
    token: required("KOMMO_API_TOKEN"),
  },
  receivablesSheetUrl:
    process.env.RECEIVABLES_SHEET_URL ??
    "https://docs.google.com/spreadsheets/d/1FTHbWRYFa_rWNsF4GvwZrf_fL5Vj5zf4ihBRv3LZw2s/export?format=csv&gid=0",
};
