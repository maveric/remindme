import { User as SupabaseUser } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";

function resolveName(user: SupabaseUser): string {
  const metadataName =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()) ||
    (typeof user.user_metadata?.name === "string" && user.user_metadata.name.trim()) ||
    "";

  if (metadataName.length > 0) {
    return metadataName;
  }

  if (user.email) {
    const [localPart] = user.email.split("@");
    return localPart.charAt(0).toUpperCase() + localPart.slice(1);
  }

  return "Permit Buddy User";
}

export async function ensureProfile(user: SupabaseUser) {
  const email = user.email ?? "";
  const name = resolveName(user);

  return prisma.user.upsert({
    where: { id: user.id },
    update: {
      email,
      name,
    },
    create: {
      id: user.id,
      email,
      name,
    },
  });
}
