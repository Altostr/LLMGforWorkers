export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getAuthStatus } from "@/lib/auth-status";
import { isAuthDisabled } from "@/lib/no-auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (isAuthDisabled()) {
    redirect("/dashboard");
  }

  const status = await getAuthStatus();
  return <LoginForm status={status} />;
}
