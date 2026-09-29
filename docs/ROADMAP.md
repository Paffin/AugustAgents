# Дорожная карта

Фазы завершаются по критериям, а не по датам.

## MVP

- [x] Каркас монорепо, CI
- [x] Lane Queue, журнал событий
- [x] Система эффектов, taint, мандаты
- [x] Реестр способностей, шорт-лист, сканер
- [x] Каскад решений Laya → LLM, теневой режим, сохранение статистики
- [x] Laya sidecar (Python, HTTP на 127.0.0.1), калибровка температуры по логам, `august laya activate`
- [x] Кросс-язычный поиск тулов: `keywords` и расширение запроса через LLM
- [x] Шлюз с loopback, Host, Origin и токеном
- [x] Лестница дистилляции (пакет)
- [x] Агентный цикл: шорт-лист → каскад → аргументы → политика → апрув → журнал
- [x] CLI: `setup`, `chat`, `serve`, `doctor`, `secret`, `mcp`, `skills`, `laya`, `calibrate`
- [x] MCP-клиент: stdio и streamable HTTP
- [x] Поиск MCP-серверов в официальном реестре и установка с апрувом; навыки `SKILL.md` с GitHub
- [x] Песочница для MCP-серверов (bubblewrap, sandbox-exec)
- [x] Хранилище секретов (Keychain, Secret Service, файл 0600)
- [x] Веб-чат и Telegram, апрувы в канале
- [x] Установщик в 3 касания (`install.sh` + `august setup`)
- [x] Red-team набор инъекций
- [x] Durable runtime Phase A: SQLite/WAL messages/runs/checkpoints, restart context, idempotency, pause/cancel/resume/retry и fail-closed ambiguous recovery

**Локальная часть Гейта 1 закрыта, сам релизный гейт ещё открыт.** На baseline 2026-09-29 (Bun 1.4.2, совместимый lockfile проверен также Bun 1.1.39) typecheck проходит, `bun test` даёт 331 pass / 0 fail, `bun run check` занимает 3.04 с, а два отдельных CLI-процесса подтвердили durable restart-контекст через локальный Qwen. `OUT-002` всё ещё требует реального token/cost accounting. До релиза также нужны чистая macOS-машина, первый подтверждённый CI run и перечисленные ниже живые platform checks. Точная evidence-запись и порядок outcomes находятся в [Agentic Foundation](agentic/WAYFINDING.md) и [Agentic Roadmap](agentic/ROADMAP.md).

Что осталось проверить руками до релиза:

- sidecar на настоящих весах Laya (из среды разработки HuggingFace и PyPI недоступны);
- установщик на чистом macOS;
- песочница bubblewrap на Linux-десктопе (в среде разработки её нет, покрыты тесты сборки аргументов).

## v1

- Лестница в агентном цикле: запись исходов, навыки из повторов, рефлексы
- Эмбеддинги для поиска тулов
- WebSocket в шлюзе, стриминг ответов
- OAuth для удалённых MCP, фильтр сети в песочнице по хостам
- Подписи пакетов и уровень `verified`; общий денылист
- Скрытый ввод секретов, шифрованное файловое хранилище
- Laya принимает решения сама после eval-гейта
- Дообучение Laya на логах (RLCD), пайплайн в Python
- Плагины OpenClaw и Hermes, импорт настроек
- Браузер, голос, мандаты на платежи

**Гейт 2:** Laya не хуже LLM на eval по каждому типу решения.

## v2

- Командный режим и роли
- Устройства-узлы, сетка состояния
- Облачный деплой
- Общий денылист навыков и федеративное обучение
