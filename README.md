# srvMC

Správce Minecraft serverů ve stylu Aternos, který běží u tebe na PC (Windows 10/11). Servery vytvoříš, zapneš a spravuješ v přehledném panelu. Serverové soubory i správná Java se stáhnou samy.

## Stažení

- **Doporučeno:** [store.opikula.dev/app/srvmc](https://store.opikula.dev/app/srvmc/)
- **Ručně:** stáhni `srvMC-Setup-<verze>.exe` z [GitHub Releases](https://github.com/OpiKula2877/srvMC/releases/latest) a spusť ho.

Instalátor není podepsaný. Když se Windows SmartScreen zeptá, klikni na **Další informace → Přesto spustit**. Servery, světy a zálohy jsou ve složce `%USERPROFILE%\srvMC` a odinstalace je nesmaže.

## Obsah

**Typy serverů:** Vanilla (i snapshoty), Paper, Purpur, Spigot, CraftBukkit, Fabric, Quilt, Forge, NeoForge, Arclight, Velocity, modpacky (Modrinth, CurseForge, Technic), Bedrock, Bedrock Preview a Hytale (experimentální).

**Co umí:**

- Víc serverů, každý s tlačítky Zapnout, Vypnout a Restart
- Konzole s příkazy a historií
- Hráči: bílá listina, operátoři, bany, vyhození
- Možnosti: úprava MOTD s barvami a živým náhledem, ikona serveru, všechna nastavení `server.properties`
- Vyhledávač modů, pluginů a modpacků (Modrinth, CurseForge, Hangar, SpigotMC) s aktualizacemi jedním klikem
- Placené i neplacené účty (přihlášení heslem)
- Světy a zálohy: nahrání, stažení, obnova, automatické zálohy
- Záznamy (logy), správce souborů
- Grafy CPU, RAM, hráčů a TPS
- Plánovač úloh, hlídač pádů s automatickým restartem, uspání a probuzení při připojení
- Limity RAM a disku
- Síť: UPnP, playit.gg, DuckDNS, vlastní doména
- Crossplay Java ↔ Bedrock (Geyser), mapa BlueMap, Velocity proxy
- Discord oznámení, statistiky hráčů
- Víc uživatelů panelu s rolemi

## Pro vývojáře

Potřebuješ Node.js 22+.

```bash
npm install
```

```bash
npm run app
```

```bash
npm test
```

```bash
npm run installer
```

Struktura: `packages/backend` (jádro, Fastify), `packages/web` (panel, React), `packages/shared` (společné typy), `apps/desktop` (Electron).
