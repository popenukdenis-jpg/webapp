# КТ Сталь · Калькулятор порізки — серверна версія

Node.js + Express + SQLite. Авторизація логін/пароль, адмін-панель, журнал дій,
керовані сесії. Калькулятор `raskroy.html` віддається тільки після входу.

## Локальна перевірка

```bash
cd server
npm install --omit=dev
ADMIN_PASSWORD=changeme npm start
# відкрити http://127.0.0.1:3000/login, увійти як admin / changeme
```

При першому запуску створюються:
- `data.sqlite`     — користувачі та журнал
- `sessions.sqlite` — сховище сесій

Якщо немає жодного користувача, сід-скрипт створює адміна (`ADMIN_USERNAME` / `ADMIN_PASSWORD`,
дефолти `admin` / `admin`). **Змініть пароль одразу після першого входу.**

## Змінні середовища

| Змінна            | Дефолт                | Примітка                                             |
|-------------------|-----------------------|------------------------------------------------------|
| `PORT`            | `3000`                |                                                      |
| `HOST`            | `127.0.0.1`           | за nginx — лише localhost                            |
| `SESSION_SECRET`  | випадкові 32 байти    | задайте сталий у production, інакше сесії скидаються при рестарті |
| `DB_PATH`         | `./data.sqlite`       | абсолютний шлях у production                         |
| `CALC_HTML`       | `../raskroy.html`     | шлях до файлу калькулятора                           |
| `NODE_ENV`        | `production`          |                                                      |
| `TRUST_PROXY`     | `0`                   | `1` коли за nginx                                    |
| `ADMIN_USERNAME`  | `admin`               | сід першого адміна (одноразово)                      |
| `ADMIN_PASSWORD`  | `admin`               | змінити після першого входу                          |

## Деплой на VPS (Ubuntu / Debian)

```bash
# 1. Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx

# 2. Користувач під сервіс
sudo useradd --system --create-home --home-dir /opt/raskroy --shell /usr/sbin/nologin raskroy

# 3. Код
sudo git clone https://github.com/popenukdenis-jpg/webapp.git /opt/raskroy
sudo chown -R raskroy:raskroy /opt/raskroy
sudo -u raskroy bash -c 'cd /opt/raskroy/server && npm install --omit=dev'

# 4. Перший запуск (одноразово, щоб створилася БД і початковий адмін)
sudo -u raskroy bash -c 'cd /opt/raskroy/server && ADMIN_PASSWORD="ваш-надійний-пароль" node server.js'
# Зупинити Ctrl+C після рядка "raskroy server listening..."

# 5. Сталий SESSION_SECRET (один раз згенерувати і вписати в systemd unit)
openssl rand -hex 32

# 6. systemd unit
sudo cp /opt/raskroy/server/raskroy.service /etc/systemd/system/raskroy.service
sudo nano /etc/systemd/system/raskroy.service
# розкоментуйте і впишіть Environment=SESSION_SECRET=...

sudo systemctl daemon-reload
sudo systemctl enable --now raskroy
sudo systemctl status raskroy

# 7. nginx + HTTPS
sudo cp /opt/raskroy/server/nginx-raskroy.conf /etc/nginx/sites-available/raskroy
sudo nano /etc/nginx/sites-available/raskroy   # підставте свій server_name
sudo ln -s /etc/nginx/sites-available/raskroy /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Сертифікат Let's Encrypt
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d porizka.example.com
```

Після цього сайт доступний на `https://porizka.example.com/`,
адмін-панель — `https://porizka.example.com/admin`.

## Оновлення

```bash
cd /opt/raskroy
sudo -u raskroy git pull
sudo -u raskroy bash -c 'cd server && npm install --omit=dev --no-audit'
sudo systemctl restart raskroy
```

## Бекап БД

```bash
sudo -u raskroy bash -c 'cd /opt/raskroy/server && sqlite3 data.sqlite ".backup data-$(date +%F).sqlite"'
```

## Структура

```
server/
├── package.json
├── server.js           # точка входу
├── views/
│   ├── login.html
│   └── admin.html
├── raskroy.service     # systemd unit (template)
├── nginx-raskroy.conf  # nginx site (template)
├── README.md
└── .gitignore          # *.sqlite, node_modules, .env
```

`raskroy.html` лежить у корені репозиторію — сервер віддає його по `GET /` за авторизацією.

## Що логується

- `login_ok`, `login_fail`, `logout`
- `view` — кожне відкриття калькулятора
- `create_user`, `enable_user`, `disable_user`, `toggle_admin`, `reset_password`, `delete_user`
- `kill_session` — примусове завершення сесії з адмінки
- `session_killed_inactive` — користувач був заблокований під час активної сесії

Журнал зберігається безстроково. Якщо потрібна ротація — додати cron або логіку в `server.js`.

## Поза цим релізом

Заплановано на майбутнє (за потреби):
- Self-service «забув пароль» через email
- 2FA
- Експорт журналу в CSV
- Графіки активності
- Міграція на PostgreSQL для масштабу

Деталі — у `PLAN.md`.
