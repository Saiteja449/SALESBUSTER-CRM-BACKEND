import jwt from "jsonwebtoken";

const JWT_SECRET = "super_secret_jwt_key_12345";

const token = jwt.sign(
  {
    id: "6aaa2a7a6d808ffa93df4436",
    email: "hello@acewebacademy.com",
    role: "sales manager",
    tenantDbName: "sb_tenant_ace_web_academy_d95ba7",
    organizationId: "6aaa2a7a6d808ffa93df442f",
    isOrgOwner: true,
  },
  JWT_SECRET,
  { expiresIn: "1d" }
);

async function checkStatus() {
  const url = "https://api.salesbuster.ai/api/whatsapp/status";
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    console.log("Status Code:", res.status);
    const data = await res.json();
    console.log("Returned Sessions for Ace Web Academy:");
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

checkStatus();
