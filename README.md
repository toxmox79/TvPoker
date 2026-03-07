# ♠ Royal Poker PWA

Texas Hold'em Poker für den Heimabend – TV + Smartphones, weltweit spielbar.

---

## 🚀 Online deployen (kostenlos, empfohlen)

### Option A: Railway  ← einfachste Option

1. Gehe auf [railway.app](https://railway.app) und melde dich mit GitHub an
2. Klicke **"New Project" → "Deploy from GitHub repo"**
3. Wähle dieses Repository aus
4. Railway erkennt Node.js automatisch und deployt
5. Klicke nach dem Deploy auf **"Settings" → "Networking" → "Generate Domain"**
6. Du bekommst eine URL wie `https://royal-poker-production.up.railway.app`
7. Diese URL im TV-Browser öffnen → QR-Code erscheint → fertig!

### Option B: Render

1. Gehe auf [render.com](https://render.com) und melde dich mit GitHub an
2. Klicke **"New" → "Web Service"**
3. Wähle dieses Repository
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Nach dem Deploy erhältst du eine URL wie `https://royal-poker.onrender.com`
6. Diese URL im TV öffnen → QR-Code scannen → spielen!

> ⚠️ **Render Free Tier**: Der Server schläft nach 15 Min Inaktivität ein.
> Beim ersten Aufruf kann es 30–60 Sekunden dauern bis er aufwacht.
> Railway hat dieses Problem nicht.

---

## 🎮 So wird gespielt

```
1. TV/Monitor: Deine Railway/Render-URL im Browser öffnen
              → QR-Code und Raum-Code werden angezeigt

2. Spieler 1:  QR-Code scannen
              → Avatar & Name wählen → Beitreten
              → Du bist automatisch MASTER
              → Einstellungen vornehmen (Bots, Blinds, Startkapital...)
              → "Spiel starten" drücken

3. Weitere:    QR-Code scannen oder URL + Raum-Code manuell eingeben
              → Avatar & Name → Beitreten → warten
```

Alle Spieler weltweit können mitspielen, solange sie die URL haben.

---

## ⚙️ Einstellungen (Master)

| Einstellung | Beschreibung |
|---|---|
| Bots | 0–5 KI-Gegner (Leicht / Mittel / Schwer) |
| Startkapital | Chips pro Spieler |
| Start Small Blind | Anfangs-Blind |
| Blind-Erhöhung | Alle X Hände steigen die Blinds |
| Max. Blind | Obergrenze für Blind-Erhöhungen |
| Timer | Sekunden pro Zug (oder unbegrenzt) |
| Karten zeigen | Alle Karten am Showdown sichtbar |

---

## 📱 Handy – 3 Views

| View | Funktion |
|---|---|
| 👁 View 1 | Karten sichtbar + Bet-Slider + 5 Aktions-Buttons |
| 👁 View 2 | Karten verdeckt – nach oben wischen zum spähen |
| 👁 View 3 | Mini-Tischansicht mit allen Spielern |

---

## 💻 Lokal ausführen

```bash
npm install
npm start
# TV:    http://localhost:3000
# Phone: http://localhost:3000/phone.html?room=CODE
```

---

## 🛠 Technologie

- **Backend:** Node.js + Socket.IO (kein Framework)
- **Frontend:** Vanilla HTML/CSS/JS – keine Build-Tools nötig
- **PWA:** Installierbar auf dem Homescreen, funktioniert im Vollbild
- **Fonts:** Cinzel, Cinzel Decorative, IM Fell English
