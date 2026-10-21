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
- `metrics\<id>\` – historie zátěže po minutách (jeden soubor na den, drží se 31 dní)
- `network.json` – DuckDNS a playit.gg; token a klíč jsou v desktopové aplikaci zašifrované klíčem uživatele Windows (Electron safeStorage)
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
- Program playit dostává tajný klíč v proměnné prostředí, ne v příkazové řádce. Stahuje se jen pevná verze s kontrolou SHA-256.

## Stav (fáze 1–7)

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

Fáze 6:

- **Grafy** – procesor, paměť, hráči a TPS za hodinu, 24 hodin, 7 a 30 dní, s tooltipem a tabulkou. Historie se ukládá po minutách na disk. TPS se měří jednou za minutu (`tps` na Paperu/Purpuru/Spigotu/Arclightu, `forge tps` / `neoforge tps`, `tick query` na Vanille, Fabricu a Quiltu od 1.20.3) a odpověď se do konzole nevypisuje.
- **Plánovač** – restart, zapnutí, vypnutí, záloha nebo příkaz ve vybrané dny a čas, nebo opakovaně po 15 minutách až 24 hodinách. Před restartem a vypnutím odpočet v chatu (5 min, 1 min, 10 s), když někdo hraje. Tlačítko „Spustit teď“ a poslední výsledek u každé úlohy.
- **Crash hlídač** – po pádu přečte crash report a konec konzole, napíše příčinu (došla paměť, obsazený port, chybějící mod, stará Java, chyba mixinu…) a podezřelé mody nebo pluginy. Restartuje za 10 s, nejvýš 3× za 10 minut; když by restart nepomohl, nechá server vypnutý. Server, který 5 minut neodpovídá na měření TPS, ukončí jako zamrzlý.
- **Spánek a probuzení** – server se může sám vypnout, když nikdo nehraje. Vypnutý server s probouzením odpovídá v seznamu serverů „Spí · připoj se a probudí se“ a při pokusu o připojení se spustí (hráč se připojí znovu za chvilku). Při prvním použití se může ozvat Windows firewall – srvMC poslouchá na portu serveru.
- **Limit disku** – velikost složky serveru se počítá každých 5 minut. Nad limitem varování, nad limitem o 10 % se server zastaví a nespustí, dokud se neuvolní místo. Nahrávání souborů, světů a jarů i instalace modů limit hlídají.

Fáze 7 – záložka **Síť a doména**:

- **Stav sítě** – adresa v síti doma, veřejná IP, CGNAT (když router přes UPnP hlásí jinou nebo neveřejnou adresu) a kontrola portu zvenku: služba mcstatus.io (záložně mcsrvstat.us) se na server připojí jako hráč. Když server neběží, srvMC na dobu kontroly na portu krátce odpovídá sám.
- **Jen doma (LAN)** – adresa pro hráče na stejné Wi-Fi.
- **playit.gg** – propojení účtu přes odkaz (schválíš na playit.gg), srvMC uloží klíč, stáhne a spustí program playit 0.17.1 a vytvoří tunel Minecraft Java na port serveru. Funguje bez nastavení routeru i za CGNAT. Verze 1.x potřebuje službu Windows, proto zatím 0.17.1.
- **Vlastní IP a otevřený port** – otevření portu na routeru přes UPnP (obnovuje se každých 20 minut, při změně portu se přesune) a ruční postup, když router UPnP neumí.
- **DuckDNS** – zdarma `něco.duckdns.org`, adresa se aktualizuje každých 10 minut.
- **Vlastní doména** – podle cíle (veřejná IP, DuckDNS, playit tunel) srvMC vypíše záznamy A / CNAME / SRV pro registrátora a ověří je přes veřejné DNS (1.1.1.1, 8.8.8.8).

Další fáze: Bedrock, Bedrock Preview a Hytale, potom Discord, Geyser, statistiky, víc uživatelů, BlueMap a Velocity (viz plán). CurseForge přijde, až bude kam zadat API klíč.

## Ikona

Zdroj je `apps/desktop/assets/icon-source.png` (průhledné pozadí). Všechny velikosti (okno, oznamovací oblast, `.ico`, favicon, logo v panelu) vyrobí:

```bash
node scripts/make-icons.mjs
```
