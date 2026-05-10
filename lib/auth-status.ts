import { getGatewaySettings } from "@/lib/settings";

export type AuthStatus = {
  password_login_enabled: boolean;
  registration_enabled: boolean;
};

export async function getAuthStatus(): Promise<AuthStatus> {
  const settings = await getGatewaySettings();
  return {
    password_login_enabled: settings.password_login_enabled === 1,
    registration_enabled: settings.registration_enabled === 1,
  };
}
