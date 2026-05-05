# Патчі калькулятора

Кожен патч — це готовий `git format-patch`-файл, який накладається поверх
поточного деплою без передеплою сервера (бо `raskroy.html` віддається статикою —
рестарт `raskroy.service` не потрібен).

## Як накласти патч на VPS

```bash
# 1) перейти в репо
cd /opt/raskroy

# 2) переконатися, що дерево чисте
sudo -u raskroy git status

# 3) наявне дерево вирівняти на ту саму базу, з якої знятий патч
sudo -u raskroy git fetch origin
# базова версія для нового патча — гілка claude/create-gable-roof-3d-8CFK1, коміт 926d87e
# (server: implement auth + admin panel backend per PLAN.md)

# 4) застосувати патч
sudo -u raskroy git am server/patches/0001-raskroy-add-piece-type-for-sheet-cutting.patch

# (Альтернатива без створення коміту):
# sudo -u raskroy git apply server/patches/0001-raskroy-add-piece-type-for-sheet-cutting.patch
```

Перевірка, що нова опція з'явилась:

```bash
grep "відрізок (на повну ширину)" /opt/raskroy/raskroy.html
```

Якщо знайдено — користувачу достатньо натиснути Ctrl+F5 у браузері (статика не
кешується сесійно, але CDN/проксі може мати власний TTL — `sudo systemctl reload nginx`
не зашкодить).

## Простий варіант — `git pull`

Якщо ви тримаєте репо в актуальному стані гілки `claude/create-gable-roof-3d-8CFK1`:

```bash
cd /opt/raskroy
sudo -u raskroy git pull origin claude/create-gable-roof-3d-8CFK1
# ніяких рестартів не потрібно — raskroy.html віддається через res.sendFile
```

## Перелік патчів

| Файл                                                          | Що додає                                                                                  |
|---------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `0001-raskroy-add-piece-type-for-sheet-cutting.patch`         | Третя опція форми деталі — «відрізок (повна ширина)». Клієнт задає лише довжину.          |

## Якщо щось пішло не так

```bash
# відкотити останній застосований патч
sudo -u raskroy git am --abort      # якщо застосовувався --am і ще не завершився
# або
sudo -u raskroy git revert HEAD     # відкотити вже закомічений патч новим комітом
```
