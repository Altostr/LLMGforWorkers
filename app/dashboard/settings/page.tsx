/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SectionTitle } from "@/components/dashboard/section-title";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { getApiMessage } from "@/lib/api-message";
import { authedFetch } from "@/lib/client-auth";
import { requireAdminDashboardProfile } from "@/lib/dashboard-client";

export default function AdminSettingsPage() {
  const router = useRouter();
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [upstreamRetryEnabled, setUpstreamRetryEnabled] = useState(true);
  const [upstreamRetryMaxAttempts, setUpstreamRetryMaxAttempts] = useState(3);
  const [circuitBreakerEnabled, setCircuitBreakerEnabled] = useState(true);
  const { toast } = useToast();

  async function ensureAdmin() {
    return Boolean(await requireAdminDashboardProfile(router));
  }

  async function load() {
    if (!(await ensureAdmin())) return;
    const response = await authedFetch("/api/dashboard/settings");
    const data = await response.json();
    if (response.ok) {
      setRegistrationEnabled(data.data.registration_enabled === 1);
      setPasswordLoginEnabled(data.data.password_login_enabled !== 0);
      setUpstreamRetryEnabled(data.data.upstream_retry_enabled !== 0);
      setUpstreamRetryMaxAttempts(Number(data.data.upstream_retry_max_attempts ?? 3));
      setCircuitBreakerEnabled(data.data.upstream_circuit_breaker_enabled !== 0);
    }
  }

  useEffect(() => {
    void load();
  }, [router]);

  async function save() {
    const response = await authedFetch("/api/dashboard/settings", {
      method: "PUT",
      body: JSON.stringify({
        registration_enabled: registrationEnabled,
        password_login_enabled: passwordLoginEnabled,
        upstream_retry_enabled: upstreamRetryEnabled,
        upstream_retry_max_attempts: upstreamRetryMaxAttempts,
        upstream_circuit_breaker_enabled: circuitBreakerEnabled,
      }),
    });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      toast({ variant: "success", description: getApiMessage(data, "保存成功。") });
      return;
    }
    toast({ variant: "error", description: getApiMessage(data, "保存失败。") });
  }

  return (
    <DashboardShell role="admin" title="系统设置" subtitle="配置登录注册策略与上游重试。">
      <div className="space-y-4 pb-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Card>
            <CardHeader>
              <SectionTitle
                title="登录与注册"
                description="控制账号密码登录入口与注册开关。限速与配额请前往「用户组」配置。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">允许账号密码登录</p>
                  <p className="text-xs text-zinc-500">关闭后用户将无法通过密码登录。</p>
                </div>
                <Switch checked={passwordLoginEnabled} onCheckedChange={setPasswordLoginEnabled} />
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">允许账号密码注册</p>
                  <p className="text-xs text-zinc-500">关闭后仅管理员可创建用户。</p>
                </div>
                <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle
                title="上游重试策略"
                description="控制渠道异常时的自动切换行为。"
              />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">开启自动切换</p>
                  <p className="text-xs text-zinc-500">命中 401、429 或 5xx 时尝试其他渠道。</p>
                </div>
                <Switch checked={upstreamRetryEnabled} onCheckedChange={setUpstreamRetryEnabled} />
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-100">上游熔断</p>
                  <p className="text-xs text-zinc-500">连续失败 3 次后暂停该渠道 15 秒，防止雪崩。关闭后所有渠道始终可用。</p>
                </div>
                <Switch checked={circuitBreakerEnabled} onCheckedChange={setCircuitBreakerEnabled} />
              </div>
              <div className="space-y-2">
                <Label>最大路由尝试次数</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={upstreamRetryMaxAttempts}
                  onChange={(e) => setUpstreamRetryMaxAttempts(Number(e.target.value))}
                />
                <p className="text-xs text-zinc-500">默认 3，建议不要超过 5，避免上游回退过慢。</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="flex items-center justify-end p-5">
            <Button onClick={save}>保存设置</Button>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
