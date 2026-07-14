export const FAIL2BAN_JAIL_PATH = "/etc/fail2ban/jail.local";
export const FAIL2BAN_NAPP_FILTER_PATH = "/etc/fail2ban/filter.d/napp-ratelimit.conf";

export function renderJailLocal(sshPort: number): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp fail2ban setup\`.
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 3
backend  = systemd
banaction = ufw

[sshd]
enabled  = true
port     = ${sshPort}
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 86400

[nginx-botsearch]
enabled  = true
port     = http,https
filter   = nginx-botsearch
logpath  = /var/log/nginx/*access.log
maxretry = 2

[nginx-http-auth]
enabled  = true
port     = http,https
filter   = nginx-http-auth
logpath  = /var/log/nginx/*error.log
maxretry = 3

[nginx-limit-req]
enabled  = true
port     = http,https
filter   = nginx-limit-req
logpath  = /var/log/nginx/*error.log
maxretry = 5

# Jail riêng cho các app Node quản lý bởi napp: chặn IP spam lỗi 502/504/429
# (thường là backend app bị treo/quá tải hoặc bị dò brute-force API).
[napp-ratelimit]
enabled  = true
port     = http,https
filter   = napp-ratelimit
logpath  = /var/log/nginx/*access.log
maxretry = 30
findtime = 60
bantime  = 1800
`;
}

export function renderNappRatelimitFilter(): string {
  return `# Managed by napp
[Definition]
failregex = ^<HOST> .* ".*" (502|504|429) .*$
ignoreregex =
`;
}
