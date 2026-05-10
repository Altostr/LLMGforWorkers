export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth-status";
import { isAuthDisabled } from "@/lib/no-auth";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  if (isAuthDisabled()) {
    redirect("/dashboard");
  }

  const status = await getAuthStatus();

  if (!status.registration_enabled) {
    redirect("/login");
  }

  return <RegisterForm status={status} />;
}
