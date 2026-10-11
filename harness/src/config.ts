import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  get mongodbUri() {
    return required("MONGODB_URI");
  },
  mongodbDb: process.env.MONGODB_DB ?? "ownerorbit",
  port: Number(process.env.PORT ?? 3000),
};
