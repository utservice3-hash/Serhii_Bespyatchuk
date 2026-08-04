import "dotenv/config";
import jwt from "jsonwebtoken";
const role = process.argv[2] ?? "admin";
const payload = role === "team_lead"
  ? { userId: 0, role: "team_lead", roleKey: "team_lead", managerId: null, teamId: Number(process.argv[3] ?? 5) }
  : { userId: 0, role: "company", roleKey: "admin", managerId: null, teamId: null };
console.log(jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" }));
