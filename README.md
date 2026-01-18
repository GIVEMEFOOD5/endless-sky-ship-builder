# Endless Sky Data Parser

https://givemefood5.github.io/endless-sky-ship-builder/

Automatically parses ship and outfit data from Endless Sky GitHub repositories.

## How It Works

This repository uses GitHub Actions to automatically fetch and parse data from Endless Sky repositories monthly. The parser searches the entire repository for all `.txt` files in the `data/` directory and extracts ship and outfit information.

## Repository Structure
```
.
├── .github/workflows/
│   └── parse-endless-sky.yml    # GitHub Actions workflow
├── data/                         # Generated data (auto-updated)
│   ├── official-game/
│   │   ├── ships.json
│   │   ├── outfits.json
│   │   └── complete.json
│   └── adde-plugin/
│       ├── ships.json
│       ├── outfits.json
│       └── complete.json
├── parser.js                     # Parser script
└── plugins.json                  # Repository configuration
```

## Adding a New Plugin

1. Edit `plugins.json`
2. Add a new entry:
```json
   {
     "name": "my-plugin",
     "repository": "https://github.com/username/repository"
   }
```
3. Commit and push the changes
4. The workflow will automatically run and generate data

## Manual Trigger

1. Go to the "Actions" tab in GitHub
2. Click "Parse Endless Sky Data"
3. Click "Run workflow"

## Scheduled Updates

The parser automatically runs on the 1st of every month at midnight UTC.

## Output Files

For each plugin, three files are generated:
- `ships.json` - All ship data (without installed outfits)
- `outfits.json` - All outfit data
- `complete.json` - Combined data with metadata
