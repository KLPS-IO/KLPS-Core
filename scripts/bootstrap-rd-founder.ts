import "dotenv/config";
import { setFounderPassword } from "../server/src/rd-lab/rd-auth.service";
import { pool } from "../server/src/storage/postgres.client";

const email = process.env.RD_FOUNDER_EMAIL;
const password = process.env.RD_FOUNDER_PASSWORD;
if (!email || !password) throw new Error("Set RD_FOUNDER_EMAIL and RD_FOUNDER_PASSWORD only for this command");

setFounderPassword(email, password)
  .then((user) => console.log(`R&D founder password established for ${user.email}`))
  .finally(() => pool.end());
