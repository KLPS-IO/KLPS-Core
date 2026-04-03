import dotenv from "dotenv";

dotenv.config();

export const env = {

  PORT: Number(process.env.PORT) || 5001,

  DB_HOST: process.env.DB_HOST!,
  DB_PORT: Number(process.env.DB_PORT),
  DB_NAME: process.env.DB_NAME!,
  DB_USER: process.env.DB_USER!,
  DB_PASSWORD: process.env.DB_PASSWORD!

};