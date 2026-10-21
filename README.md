# srvMC

Lokální správce Minecraft serverů ve stylu Aternos. Běží na tvém PC jako desktopová aplikace (Electron) s webovým panelem uvnitř.

Instalace obsahuje jen panel. Serverové soubory a správná Java se stáhnou až při vytvoření serveru, a to z oficiálních zdrojů:

| Typ | Zdroj |
|---|---|
| Vanilla, snapshoty | piston-meta.mojang.com |
| Paper | fill.papermc.io (API v3) |
| Purpur | api.purpurmc.org (kontrola MD5) |
| Spigot, CraftBukkit | BuildTools z hub.spigotmc.org – kompiluje se u tebe, výsledek jde do cache |
| Fabric | meta.fabricmc.net + vanilla jar od Mojangu |
| Quilt | meta.quiltmc.org + Quilt installer |
| Forge | maven.minecraftforge.net – installer `--installServer` |
| NeoForge | maven.neoforged.net – installer `--installServer` |
| Arclight | GitHub releases IzzelAliz/Arclight (Forge, NeoForge i Fabric varianta) |
| Modpacky | Modrinth `.mrpack` – loader podle modpacku, jen soubory pro server |
| Mody, pluginy | Modrinth, Hangar (PaperMC), SpigotMC přes Spiget |
| Java | Eclipse Temurin přes api.adoptium.net |

Stažené soubory jdou do sdílené cache. Hash (SHA-1 nebo SHA-256) se kontroluje po každém stažení i při použití z cache.

## Spuštění

Potřebuješ Node.js 22 nebo novější.

```bash
npm install
```

Desktopová aplikace (sestaví panel i Electron a spustí okno):

```bash
npm run app
```

Vývoj s automatickým obnovováním (API na portu 8420, panel na http://localhost:5173):

```bash
npm run dev
```

Testy a kontrola typů:

```bash
npm test
```

```bash
npm run typecheck
```

npm 12 ve výchozím stavu blokuje instalační skripty. `electron` a `esbuild` jsou povolené v `allowScripts` v `package.json`. Když Electron hlásí „failed to install correctly“, stáhni ho ručně: `node node_modules/electron/install.js`.

## Kde jsou data

Vše je v `%USERPROFILE%\srvMC` (jinou složku nastavíš proměnnou `SRVMC_HOME`):

- `servers\<id>\` – jednotlivé servery (svět, pluginy, `server.properties`)
- `cache\` – stažené jary a Java archivy
- `runtimes\temurin-<verze>\` – Java
- `backups\<id>\` – zálohy (`RRRR-MM-DD_HH-MM-SS_<druh>.zip`)
- `trash\<id>\` – smazané soubory a světy (jde je ručně vrátit)
- `servers.json` – seznam serverů a jejich nastavení

## Struktura

```
packages/shared    typy a konstanty sdílené jádrem a panelem
packages/backend   jádro: Fastify API + WebSocket, instalace, procesy serverů
  src/providers/   jeden soubor na typ serveru (vanilla, paper, fabric, forge, modpack…)
packages/web       panel v Reactu (vlastní dropdowny, scrollbary, přepínače)
apps/desktop       Electron: okno, ikona v oznamovací oblasti, balí jádro i panel
```

## Bezpečnost

- API poslouchá jen na `127.0.0.1`.
- Požadavky s cizí hlavičkou `Host` nebo `Origin` dostanou 403 (ochrana proti DNS rebindingu a jiným webům).
- Každá změna přes API musí nést hlavičku `x-srvmc: 1`.
- Servery se spouštějí bez shellu, s polem argumentů. Vlastní JVM argumenty musí začínat `-`.

## Stav (fáze 1–5)

Fáze 1: vytvoření serveru (Vanilla, Paper, Fabric), automatická Java, start, stop, restart a násilné ukončení, živá konzole s historií příkazů, grafy CPU a RAM, hráči online, nastavení RAM, portu, JVM a časového pásma, autostart, mazání serveru. Když zavřeš okno, servery běží dál v oznamovací oblasti.

Fáze 2:

- **Hráči** – bílá listina, operátoři s úrovní, bany hráčů a IP, vyhození. Za běhu jdou změny přes příkazy v konzoli, jinak přímo do JSON souborů. UUID se dohledá u Mojangu, nebo se v offline režimu dopočítá.
- **Možnosti** – MOTD s barvami (`&a`, `&l`…) a živým náhledem, ikona serveru (automaticky zmenšená na 64×64), volba ověřování účtů, všechny vlastnosti `server.properties` s českým popisem.
- **Záznamy** – `latest.log`, starší `.log.gz` a crash reporty, hledání a filtr chyb.
- **Soubory** – procházení, editor textu (Ctrl+S), nahrávání přetažením (až 1 GB), složky, přejmenování, rozbalení `.zip`. Mazání přesouvá do `trash\`. Za běhu serveru je mazání a přejmenování zamčené.

Fáze 3:

- **Světy** – seznam světů s verzí, seedem a velikostí (umí starý formát i nový z Minecraftu 26.x), nahrání zipu (najde `level.dat` i ve vnořené složce, přejmenuje i `_nether` a `_the_end`), stažení jako zip i za běhu, přepnutí aktivního světa, nový svět se seedem a typem, reset a smazání do koše.
- **Zálohy** – celý server bez věcí, které si stáhne znovu (`libraries`, `cache`, `versions`, `logs`). Za běhu se pozastaví ukládání (`save-off`, `save-all flush`, `save-on`). Automaticky každou hodinu, 6 hodin, den nebo týden s rotací. Obnova udělá nejdřív pojistnou zálohu.
- **Pre-generace** – Chunky se stáhne z Modrinthu (i se závislostmi). Poloměr, tvar, dimenze, hranice světa a živý průběh s odhadem času.
- Když srvMC spadne a server zůstane běžet, při dalším startu se osiřelý proces najde a ukončí.

Fáze 4: Purpur, Spigot a CraftBukkit (BuildTools s vlastním JDK, první sestavení trvá 10–30 minut, jar se ukládá do `cache\spigot` a další servery stejné verze ho použijí hned), Quilt (výchozí je nejnovější Quilt Loader – poslední „stabilní“ verze nové Minecrafty nespustí), Forge, NeoForge a Arclight. Instalátory běží s výstupem v konzoli serveru. Forge a NeoForge se spouští podle `run.bat`/`run.sh`, které instalátor vytvoří (args soubory, shim jar, u starých verzí přímo forge jar).

Fáze 5:

- **Mody a pluginy** – hledání na Modrinthu, Hangaru a SpigotMC s filtrem na loader a verzi serveru. Instalace i se závislostmi, mody jen pro hráče (shadery, minimapy…) server odmítne. Prémiové pluginy a ty, co se stahují jen z webu autora, mají odkaz na web.
- **Nainstalované** – zapnout a vypnout (`.jar.disabled`), smazat do koše, kontrola aktualizací přes Modrinth a aktualizace jedním klikem (starý jar jde do koše). Ručně přidané jary se rozpoznají podle hashe. Měnit jde jen vypnutý server, protože Windows drží jary zamčené.
- **Ruční nahrání jaru** – srvMC přečte `plugin.yml`, `fabric.mod.json` nebo `mods.toml` a nepustí plugin mezi mody, mod pro jiný loader ani mod jen pro klienta.
- **Modpacky** – výběr z Modrinthu přímo v průvodci. Nainstaluje se loader modpacku (Fabric, Quilt, Forge, NeoForge), jen serverové soubory a `overrides`. Cesty mimo složku serveru a spustitelné skripty se přeskočí.
- **Placené i neplacené účty** – na Paperu, Purpuru a Spigotu AuthMe Reloaded + PacketEvents (placení hráči napíšou jednou `/premium`), na Fabricu a Quiltu EasyAuth. Vypne `online-mode` i `enforce-secure-profile`. Při návratu na „jen placené“ se auth pluginy vypnou, ne smažou.

Další fáze: grafy a plánovač, crash hlídač, síť a doména, Bedrock (viz plán). CurseForge přijde, až bude kam zadat API klíč.

## Ikona

Zdroj je `apps/desktop/assets/icon-source.png` (průhledné pozadí). Všechny velikosti (okno, oznamovací oblast, `.ico`, favicon, logo v panelu) vyrobí:

```bash
node scripts/make-icons.mjs
```
