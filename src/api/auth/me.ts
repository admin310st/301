import { Context } from "hono";
import { jwtVerify } from "jose";

export async function me(c: Context) {
  const env = c.env;
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return c.json({ error: "Missing Authorization header" }, 401);

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET || "dev_secret");
    const { payload } = await jwtVerify(token, secret);

    const user = await env.DB301.prepare(
      "SELECT id, email, name, role FROM users WHERE id=?"
    )
      .bind(payload.user_id)
      .first();

    if (!user) return c.json({ error: "User not found" }, 404);

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || "user",
    });
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

