# План: серверна версія калькулятора КТ Сталь

Документ зафіксує домовленості та архітектуру до старту імплементації.

## Вхідні вимоги (узгоджено)

| № | Питання                          | Відповідь                                                |
|---|----------------------------------|----------------------------------------------------------|
| 1 | Сервер                           | Власний VPS                                              |
| 2 | Кількість користувачів           | 15–20 зараз; можливо публічний сервіс у майбутньому      |
| 3 | Авторизація                      | Логін + пароль                                           |
| 4 | Реєстрація                       | Тільки через адміна; можливість заблокувати акаунт       |
| 5 | Адміни                           | Кілька                                                   |

## Цілі

- Перенести `raskroy.html` за авторизацію.
- Адмін бачить хто, коли і з якого IP заходив, які дії робив.
- Адмін може створити, заблокувати, розблокувати, видалити акаунт; примусово завершити сесію.

## Технологічний стек

- **Runtime**: Node.js ≥ 18
- **HTTP**: Express 4
- **БД**: SQLite через `better-sqlite3` (один файл, без сервера БД)
- **Сесії**: `express-session` зі сховищем `connect-sqlite3`
- **Хешування паролів**: `bcryptjs`
- **Reverse proxy**: nginx (HTTPS через Let's Encrypt / certbot)
- **Запуск як сервіс**: systemd unit

Чому SQLite — для 15–20 користувачів цілком вистачить. Якщо стане публічним, перейдемо на PostgreSQL без зміни схеми (через міграцію `pg_dump`-аналог).

## Структура файлів

```
server/
├── package.json
├── server.js               # точка входу
├── views/
│   ├── login.html          # сторінка входу
│   └── admin.html          # адмін-панель
├── public/                 # для майбутніх ассетів
├── data.sqlite             # автоматично створюється
├── sessions.sqlite         # автоматично створюється
└── README.md               # деплой
```

`raskroy.html` залишається в корені репо. Сервер віддає його напряму через `res.sendFile(path.join(__dirname, '..', 'raskroy.html'))`. Шлях налаштовується через `CALC_HTML` env.

## Схема бази

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,         -- bcrypt
    is_admin INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,         -- 0 = заблокований
    created_at INTEGER NOT NULL,         -- ms epoch
    last_login INTEGER                   -- ms epoch
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,                     -- null для login_fail
    action TEXT NOT NULL,                -- login_ok / login_fail / logout / view / create_user / disable_user / ...
    details TEXT,                        -- JSON-blob
    ip TEXT,
    user_agent TEXT,
    ts INTEGER NOT NULL
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
```

Сесії живуть у окремому файлі `sessions.sqlite` — це дефолт `connect-sqlite3`.

## Endpoints

### Публічні

| Метод | Шлях      | Призначення                                                   |
|-------|-----------|---------------------------------------------------------------|
| GET   | `/login`  | Форма входу. Параметр `?msg=disabled\|error` показує банер.   |
| POST  | `/login`  | `{username, password}` → редирект `/` або `/admin`            |
| POST  | `/logout` | Знищити сесію → `/login`                                      |

### Захищені (потрібен валідний `req.session.userId` і `is_active=1`)

| Метод  | Шлях              | Призначення                                  |
|--------|-------------------|----------------------------------------------|
| GET    | `/`               | Калькулятор (`raskroy.html`); пише `view`    |
| POST   | `/api/log`        | Опційно — фронт може писати свої події       |

### Адмін (`is_admin=1`)

| Метод  | Шлях                                  | Призначення                          |
|--------|---------------------------------------|--------------------------------------|
| GET    | `/admin`                              | Адмін-панель                         |
| GET    | `/admin/api/users`                    | Список користувачів                  |
| POST   | `/admin/api/users`                    | Створити: `{username, password, is_admin}` |
| POST   | `/admin/api/users/:id/active`         | `{active: true\|false}`              |
| POST   | `/admin/api/users/:id/admin`          | `{is_admin: true\|false}`            |
| POST   | `/admin/api/users/:id/password`       | `{password}` — скинути               |
| DELETE | `/admin/api/users/:id`                | Видалити                             |
| GET    | `/admin/api/log?limit=200`            | Журнал дій                           |
| GET    | `/admin/api/sessions`                 | Активні сесії                        |
| DELETE | `/admin/api/sessions/:sid`            | Завершити сесію примусово            |

Перестрахівки: не можна заблокувати/змінити роль/видалити самого себе.

## Сторінки

### `/login`
Карточка з логотипом КТ Сталь, поля **Логін** і **Пароль**, банер з помилкою/повідомленням, жовта primary-кнопка «Увійти». Той самий стиль, що й калькулятор.

### `/admin`
Чотири блоки:
1. **Додати користувача** — інлайн-форма з логіном, паролем, чекбоксом «Адмін».
2. **Користувачі** — таблиця: логін, роль, стан, створено, останній вхід, дії (заблокувати / зробити адміном / змінити пароль / видалити).
3. **Активні сесії** — користувач, частина SID, expires, кнопка «Завершити».
4. **Журнал дій** — останні 200 подій з фільтрами часу/користувача (час, користувач, дія, IP, деталі).

Авто-оновлення кожні 30 секунд.

## Безпека

- Паролі в BCrypt 10 раундів; ніколи не повертаються в API.
- Cookie `kt.sid` — `httpOnly`, `sameSite=lax`, `secure` коли `NODE_ENV=production` і за proxy.
- `SESSION_SECRET` — env-змінна, генерується при першому старті, якщо її немає.
- `trust proxy` вмикається через env, щоб правильно бачити IP за nginx.
- Захист від брутфорсу: затримка 1 секунда на невдалу спробу + ліміт 5 спроб за 5 хв (через `express-rate-limit`, додамо).
- CSRF: усі mutating-запити йдуть з тієї ж origin; `sameSite=lax` блокує крос-сайт. Для адмін-API — окремий заголовок не потрібен на цьому етапі.
- Логи зберігають IP і user-agent (обрізані до 200 символів).

## Конфігурація через env

| Змінна           | Дефолт                  | Призначення                          |
|------------------|-------------------------|--------------------------------------|
| `PORT`           | 3000                    |                                      |
| `HOST`           | 127.0.0.1               | За nginx — лише localhost            |
| `SESSION_SECRET` | випадкові 32 байти      | задавайте сталий у production        |
| `DB_PATH`        | `./data.sqlite`         |                                      |
| `CALC_HTML`      | `../raskroy.html`       | шлях до калькулятора                 |
| `NODE_ENV`       | production              |                                      |
| `TRUST_PROXY`    | 0                       | `1` за nginx                         |
| `ADMIN_USERNAME` | admin                   | сід першого адміна (одноразово)      |
| `ADMIN_PASSWORD` | admin                   | змінити одразу після першого входу   |

## Деплой (стисло)

1. На VPS встановити Node.js ≥ 18 (`apt install nodejs`).
2. Клонувати репо в `/opt/raskroy`.
3. `cd /opt/raskroy/server && npm install --omit=dev`.
4. Запустити вручну, щоб створилася БД і початковий адмін: `ADMIN_PASSWORD=secret npm start`.
5. Створити systemd-юніт `/etc/systemd/system/raskroy.service` з `User=`, `WorkingDirectory=/opt/raskroy/server`, `ExecStart=/usr/bin/node server.js`, `Environment=...`.
6. nginx site-config: HTTPS (certbot), proxy_pass на 127.0.0.1:3000.
7. `systemctl enable --now raskroy`.

## Поза скоупом MVP

Це залишимо на пізніше, не блокує запуск:

- Self-service «Забув пароль» через email.
- Двофакторна автентифікація.
- API-ключі для зовнішніх інтеграцій.
- Експорт журналу в CSV.
- Графіки активності в адмінці.
- Міграції на PostgreSQL.

## Що уточнити перед стартом

- Доменне імʼя для калькулятора (для HTTPS-сертифіката).
- IP/SSH вашого VPS (щоб згодом запустити деплой).
- Чи логувати кожне натискання «Розрахувати» з параметрами замовлення (обʼєм даних і чи треба їх показувати в адмінці).
- Який email на нотифікації при невдалих спробах входу (опційно).

## Орієнтовні витрати часу

| Етап                                         | Час     |
|----------------------------------------------|---------|
| Каркас express + БД + сесії                  | 1 год   |
| Login/logout + middleware + сід адміна       | 1 год   |
| Адмін-панель: users CRUD                     | 2 год   |
| Адмін-панель: sessions + log                 | 1 год   |
| Сторінка /login + дизайн                     | 1 год   |
| Налагодження + тести руками                  | 1 год   |
| README + systemd unit + nginx-конфіг         | 1 год   |
| **Разом**                                    | ~8 год  |

## Дій після підтвердження плану

1. Створити `server/package.json`, `server/server.js`, `server/views/login.html`, `server/views/admin.html`, `server/README.md`.
2. Закомітити в окрему папку `server/` тієї ж гілки (або в нову — на ваш вибір).
3. Запустити локально, переконатися що /login працює, адмін заходить, створює користувача, тестовий користувач відкриває калькулятор.
4. Видати інструкції для деплою на ваш VPS — через сесію SSH, або скрипт `deploy.sh`.
