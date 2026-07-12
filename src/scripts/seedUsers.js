/**
 * seedUsers.js - מגדיר סיסמאות וקונפיג עמלות למשתמשים שנוצרו בייבוא.
 *   node src/scripts/seedUsers.js
 * אפשר לעקוף סיסמאות דרך משתני סביבה: SEED_MANAGER_PW / SEED_MORAN_PW / SEED_MICHAL_PW
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: User } = await import("../models/User.js");

const ensure = async ({
  name,
  email,
  role,
  password,
  commission,
  aliases,
  superAdmin,
}) => {
  let user = await User.findOne({ name });
  if (!user) user = new User({ name, role });
  user.email = email || user.email;
  user.role = role;
  user.active = true;
  user.superAdmin = Boolean(superAdmin);
  if (aliases) user.aliases = aliases;
  if (commission)
    user.commission = { ...user.commission?.toObject?.(), ...commission };
  await user.setPassword(password);
  await user.save();
  return { name, email, role, password, superAdmin: Boolean(superAdmin) };
};

await connectDB();

const seeded = [];
// המנהל בפועל של העסק.
seeded.push(
  await ensure({
    name: "יקיר",
    email: "yakir@safra.co.il",
    role: "manager",
    password: process.env.SEED_YAKIR_PW || "yakir123",
  }),
);
// עדן - מנהל + super-admin (יכול "לצפות כ..." כל משתמש).
seeded.push(
  await ensure({
    name: "עדן",
    email: "eededeedencohen@gmail.com",
    role: "manager",
    superAdmin: true,
    password: process.env.SEED_MANAGER_PW || "safra-admin",
  }),
);
seeded.push(
  await ensure({
    name: "מורן",
    email: "moran@safra.co.il",
    role: "rep",
    aliases: ["מורן"],
    password: process.env.SEED_MORAN_PW || "moran123",
    commission: { baseSalary: 6000, commissionRate: 0.1 },
  }),
);
seeded.push(
  await ensure({
    name: "מיכל פרייס",
    email: "michal@safra.co.il",
    role: "rep",
    aliases: ["מיכל", "מיכל פרייס"],
    password: process.env.SEED_MICHAL_PW || "michal123",
    commission: { baseSalary: 6000, commissionRate: 0.1 },
  }),
);

console.log("\n✅  Users seeded (login credentials):");
seeded.forEach((u) =>
  console.log(
    `   ${u.role.padEnd(8)} | ${u.name.padEnd(12)} | ${u.email} | ${u.password}`,
  ),
);
console.log("\n⚠️  Change these passwords in production.");

await disconnectDB();
process.exit(0);
