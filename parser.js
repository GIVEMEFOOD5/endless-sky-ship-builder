// parser.js - Endless Sky data parser for GitHub Actions
const https = require('https');
const fs = require('fs').promises;
const path = require('path');

class EndlessSkyParser {
  constructor() {
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    this.pendingVariants = []; // Store variants to process later
  }

  fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {}
      };
      
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        options.headers['User-Agent'] = 'endless-sky-parser';
      }
      
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
      }).on('error', reject);
    });
  }

  async fetchGitHubRepo(owner, repo, branch) {
    if (!branch) branch = 'master';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    
    console.log(`Fetching repository tree for ${owner}/${repo}...`);
    
    try {
      const data = await this.fetchUrl(apiUrl);
      const tree = JSON.parse(data);
      
      if (tree.message) {
        throw new Error(`GitHub API Error: ${tree.message}`);
      }
      
      if (!tree.tree) {
        throw new Error(`No tree data found. API may have rate limited the request.`);
      }
      
      const dataFiles = tree.tree.filter((file) => {
        return file.path.includes('data/') && 
               file.path.endsWith('.txt') &&
               file.type === 'blob';
      });
      
      console.log(`Found ${dataFiles.length} .txt files in data/ directory`);
      
      const fileContents = [];
      for (const file of dataFiles) {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
        console.log(`  Fetching ${file.path}...`);
        try {
          const content = await this.fetchUrl(rawUrl);
          fileContents.push({ path: file.path, content: content });
        } catch (error) {
          console.error(`  Error fetching ${file.path}:`, error.message);
        }
      }
      
      return fileContents;
    } catch (error) {
      console.error('Full error:', error);
      throw error;
    }
  }

  parseIndentedBlock(lines, startIdx) {
    const data = {};
    let i = startIdx;
    const baseIndent = lines[i].length - lines[i].replace(/^\t+/, '').length;
    let descriptionLines = [];
    
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      
      const currentIndent = line.length - line.replace(/^\t+/, '').length;
      
      if (currentIndent < baseIndent) break;
      
      if (currentIndent === baseIndent) {
        const stripped = line.trim();
        
        // Handle unquoted key with quoted value: category "Utility"
        const unquotedKeyMatch = stripped.match(/^([a-z\s]+)\s+"([^"]+)"$/i);
        if (unquotedKeyMatch) {
          const key = unquotedKeyMatch[1].trim();
          const value = unquotedKeyMatch[2];
          data[key] = value;
          i++;
          continue;
        }
        
        // Handle quoted key-value: "cost" 27690000
        if (stripped.includes('"')) {
          const match = stripped.match(/"([^"]+)"(?:\s+(.*))?/);
          if (match) {
            const key = match[1];
            const valueStr = (match[2] || '').trim();
            
            let value;
            if (!valueStr) {
              value = true;
            } else {
              const num = parseFloat(valueStr);
              value = !isNaN(num) ? num : valueStr;
            }
            
            if (key in data) {
              if (!Array.isArray(data[key])) {
                data[key] = [data[key]];
              }
              data[key].push(value);
            } else {
              data[key] = value;
            }
            i++;
            continue;
          }
        }
        
        // Check for unquoted key-value pairs (like: cost 27690000)
        const simpleMatch = stripped.match(/^(\S+)\s+(.+)$/);
        if (simpleMatch && !stripped.includes('"')) {
          const key = simpleMatch[1];
          const valueStr = simpleMatch[2].trim();
          const num = parseFloat(valueStr);
          data[key] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }
        
        // Check if next line is indented (nested block)
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > currentIndent) {
            const key = stripped.replace(/"/g, '');
            const result = this.parseIndentedBlock(lines, i + 1);
            const nestedData = result[0];
            const nextI = result[1];
            
            if (key in data) {
              if (!Array.isArray(data[key])) {
                data[key] = [data[key]];
              }
              data[key].push(nestedData);
            } else {
              data[key] = nestedData;
            }
            
            i = nextI;
            continue;
          } else {
            // This is a description line (no quotes, no nested content)
            descriptionLines.push(stripped);
          }
        } else {
          // Last line - likely description
          descriptionLines.push(stripped);
        }
      }
      
      i++;
    }
    
    // Combine description lines
    if (descriptionLines.length > 0) {
      data.description = descriptionLines.join(' ');
    }
    
    return [data, i];
  }

  parseShip(lines, startIdx) {
    const line = lines[startIdx].trim();
    const match = line.match(/^ship\s+"([^"]+)"(?:\s+"([^"]+)")?/);
    
    if (!match) {
      return [null, startIdx + 1];
    }
    
    const baseName = match[1];
    const variantName = match[2];
    
    // If this is a variant, store it for later processing
    if (variantName) {
      const variantData = {
        baseName: baseName,
        variantName: variantName,
        startIdx: startIdx,
        lines: lines
      };
      this.pendingVariants.push(variantData);
      
      // Skip to the end of this variant definition
      let i = startIdx + 1;
      while (i < lines.length) {
        const currentLine = lines[i];
        if (!currentLine.trim()) {
          i++;
          continue;
        }
        const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
        if (indent === 0) {
          break;
        }
        i++;
      }
      return [null, i];
    }
    
    const shipData = { 
      name: baseName
    }
    
    shipData.engines = [];
    shipData.reverseEngines = [];
    shipData.steeringEngines = [];
    shipData.guns = [];
    shipData.turrets = [];
    shipData.bays = [];
    
    let descriptionLines = [];
    let i = startIdx + 1;
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) {
        i++;
        continue;
      }
      
      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
      
      if (indent === 0 && currentLine.trim()) {
        break;
      }
      
      const stripped = currentLine.trim();
      
      if (indent === 1) {
        // Handle engine entries
        if (stripped.startsWith('engine ')) {
          const parts = stripped.substring(7).trim().split(/\s+/);
          const engineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            engineData.zoom = parseFloat(parts[2]);
          }
          shipData.engines.push(engineData);
          i++;
          continue;
        }
        
        // Handle reverse engine entries
        if (stripped.startsWith('"reverse engine"') || stripped.startsWith('reverse engine')) {
          const parts = stripped.replace(/"/g, '').substring(14).trim().split(/\s+/);
          const reverseEngineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            reverseEngineData.zoom = parseFloat(parts[2]);
          }
          
          // Check for nested properties like "over"
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) {
                  break;
                }
                const propStripped = propLine.trim();
                if (propStripped) {
                  reverseEngineData.position = propStripped;
                }
                i++;
              }
              shipData.reverseEngines.push(reverseEngineData);
              continue;
            }
          }
          
          shipData.reverseEngines.push(reverseEngineData);
          i++;
          continue;
        }
        
        // Handle steering engine entries
        if (stripped.startsWith('"steering engine"') || stripped.startsWith('steering engine')) {
          const parts = stripped.replace(/"/g, '').substring(15).trim().split(/\s+/);
          const steeringEngineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            steeringEngineData.zoom = parseFloat(parts[2]);
          }
          
          // Check for nested properties
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) {
                  break;
                }
                const propStripped = propLine.trim();
                if (propStripped) {
                  steeringEngineData.position = propStripped;
                }
                i++;
              }
              shipData.steeringEngines.push(steeringEngineData);
              continue;
            }
          }
          
          shipData.steeringEngines.push(steeringEngineData);
          i++;
          continue;
        }
        
        // Handle gun entries
        if (stripped.startsWith('gun ')) {
          const parts = stripped.substring(4).trim().split(/\s+/);
          const gunData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1]),
            gun: ""
          };
          
          shipData.guns.push(gunData);
          i++;
          continue;
        }
        
        // Handle turret entries
        if (stripped.startsWith('turret ')) {
          const parts = stripped.substring(7).trim().split(/\s+/);
          const turretData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1]),
            turret: ""
          };

          shipData.turrets.push(turretData);
          i++;
          continue;
        }
        
        // Handle bay entries
        if (stripped.startsWith('bay ')) {
          const bayMatch = stripped.match(/bay\s+"([^"]+)"\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          if (bayMatch) {
            const bayData = {
              type: bayMatch[1],
              x: parseFloat(bayMatch[2]),
              y: parseFloat(bayMatch[3])
            };
            if (bayMatch[4]) {
              bayData.position = bayMatch[4];
            }
            
            // Check for nested bay properties
            if (i + 1 < lines.length) {
              const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
              if (nextIndent > indent) {
                i++;
                while (i < lines.length) {
                  const bayLine = lines[i];
                  const bayLineIndent = bayLine.length - bayLine.replace(/^\t+/, '').length;
                  if (bayLineIndent <= indent) {
                    break;
                  }
                  const bayLineStripped = bayLine.trim();
                  const effectMatch = bayLineStripped.match(/"([^"]+)"\s+"([^"]+)"/);
                  if (effectMatch) {
                    bayData[effectMatch[1]] = effectMatch[2];
                  }
                  i++;
                }
                shipData.bays.push(bayData);
                continue;
              }
            }
            
            shipData.bays.push(bayData);
            i++;
            continue;
          }
        }
        
        // Handle "add attributes" - this indicates a variant, skip entire section
        if (stripped === 'add attributes') {
          // This shouldn't happen as we skip variants, but just in case
          i++;
          while (i < lines.length) {
            const attrLine = lines[i];
            const attrIndent = attrLine.length - attrLine.replace(/^\t+/, '').length;
            if (attrIndent <= indent) {
              break;
            }
            i++;
          }
          continue;
        }
        
        // Handle outfits section - SKIP IT
        if (stripped === 'outfits') {
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
            if (nextIndent <= indent && nextLine.trim()) {
              break;
            }
            i++;
          }
          continue;
        }
        
        // Handle description keyword (can use backticks or quotes)
        if (stripped === 'description' || stripped.startsWith('description ')) {
          // Check if description is on the same line
          const descMatch = stripped.match(/description\s+[`"](.+)[`"]$/);
          if (descMatch) {
            descriptionLines.push(descMatch[1]);
            i++;
            continue;
          }
          
          // Multi-line description starting with backtick or quote on same line
          const startMatch = stripped.match(/description\s+[`"](.*)$/);
          if (startMatch) {
            const startText = startMatch[1];
            // Check if it ends on the same line
            if (startText.endsWith('`') || startText.endsWith('"')) {
              descriptionLines.push(startText.slice(0, -1));
              i++;
              continue;
            }
            // Start of multi-line, add first part
            if (startText) {
              descriptionLines.push(startText);
            }
            i++;
            
            // Continue reading until we find the closing backtick/quote
            while (i < lines.length) {
              const descLine = lines[i];
              const descStripped = descLine.trim();
              
              // Check if this line ends the description
              if (descStripped.endsWith('`') || descStripped.endsWith('"')) {
                const finalText = descStripped.slice(0, -1);
                if (finalText) {
                  descriptionLines.push(finalText);
                }
                i++;
                break;
              }
              
              // Check if we've outdented (shouldn't happen in proper format)
              const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
              if (descIndent <= indent && descLine.trim()) {
                break;
              }
              
              if (descStripped) {
                descriptionLines.push(descStripped);
              }
              i++;
            }
            continue;
          }
          
          // Old format: indented description lines
          i++;
          while (i < lines.length) {
            const descLine = lines[i];
            const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
            if (descIndent <= indent) {
              break;
            }
            const descStripped = descLine.trim();
            if (descStripped) {
              descriptionLines.push(descStripped);
            }
            i++;
          }
          continue;
        }
        
        // Handle regular attributes with quotes
        if (stripped.includes('"')) {
          const matchResult = stripped.match(/"([^"]+)"(?:\s+(.*))?/);
          if (matchResult) {
            const key = matchResult[1];
            const value = (matchResult[2] || '').trim();
            
            // Skip sprite and thumbnail entries
            if (key.startsWith('ship/') || key.startsWith('thumbnail/')) {
              i++;
              continue;
            }
            
            shipData[key] = value || true;
          }
        } else if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > indent) {
            const key = stripped.replace(/"/g, '');
            
            // Skip certain known blocks we don't want
            if (key === 'leak' || key === 'explode' || key === 'final explode') {
              i++;
              continue;
            }
            
            const result = this.parseIndentedBlock(lines, i + 1);
            const nestedData = result[0];
            const nextI = result[1];
            shipData[key] = nestedData;
            i = nextI;
            continue;
          } else {
            // Lines without quotes and no nested content might be description remnants
            // Skip them since we handle description separately
            i++;
            continue;
          }
        }
      }
      
      i++;
    }
    
    // Combine description lines
    if (descriptionLines.length > 0) {
      shipData.description = descriptionLines.join(' ');
    }
    
    return [shipData, i];
  }

  parseShipVariant(variantInfo) {
    const baseName = variantInfo.baseName;
    const variantName = variantInfo.variantName;
    const startIdx = variantInfo.startIdx;
    const lines = variantInfo.lines;

    // Find the base ship to clone
    const baseShip = this.ships.find(function(s) { 
      return s.name === baseName; 
    });

    if (!baseShip) {
      console.warn('Warning: Base ship "' + baseName + '" not found for variant "' + variantName + '"');
      return null;
    }

    // Deep clone the base ship
    const variantShip = JSON.parse(JSON.stringify(baseShip));
    variantShip.name = baseName + ' (' + variantName + ')';
    variantShip.variant = variantName;
    variantShip.baseShip = baseName;

    // Parse the variant's modifications
    let i = startIdx + 1;
    let hasSignificantChanges = false;

    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) {
        i++;
        continue;
      }

      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;

      if (indent === 0) {
        break;
      }

      const stripped = currentLine.trim();

      if (indent === 1) {
        // Skip outfits section - variants that only change outfits are not significant
        if (stripped === 'outfits') {
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextIndent = nextLine.length - nextLine.replace(/^\t+/, '').length;
            if (nextIndent <= indent && nextLine.trim()) {
              break;
            }
            i++;
          }
          continue;
        }
        
        // Handle sprite changes
        if (stripped.startsWith('sprite ')) {
          const spriteMatch = stripped.match(/sprite\s+"([^"]+)"/);
          if (spriteMatch) {
            variantShip.sprite = spriteMatch[1];
            hasSignificantChanges = true;
          }
          i++;
          continue;
        }
        
        // Handle thumbnail changes
        if (stripped.startsWith('thumbnail ')) {
          const thumbMatch = stripped.match(/thumbnail\s+"([^"]+)"/);
          if (thumbMatch) {
            variantShip.thumbnail = thumbMatch[1];
            hasSignificantChanges = true;
          }
          i++;
          continue;
        }
        
        // Handle "add attributes"
        if (stripped === 'add attributes') {
          hasSignificantChanges = true;
          i++;
          if (!variantShip.attributes) {
            variantShip.attributes = {};
          }
          while (i < lines.length) {
            const attrLine = lines[i];
            const attrIndent = attrLine.length - attrLine.replace(/^\t+/, '').length;
            if (attrIndent <= indent) {
              break;
            }
            const attrStripped = attrLine.trim();
            
            // Parse attribute modifications
            const quotedMatch = attrStripped.match(/"([^"]+)"\s+(.+)/);
            if (quotedMatch) {
              const key = quotedMatch[1];
              const valueStr = quotedMatch[2].trim();
              const num = parseFloat(valueStr);
              const value = isNaN(num) ? valueStr : num;
              
              // Add to existing value if it exists
              if (key in variantShip.attributes && typeof variantShip.attributes[key] === 'number' && typeof value === 'number') {
                variantShip.attributes[key] += value;
              } else {
                variantShip.attributes[key] = value;
              }
            }
            i++;
          }
          continue;
        }
        
        // Handle engine additions/changes
        if (stripped.startsWith('engine ')) {
          hasSignificantChanges = true;
          const parts = stripped.substring(7).trim().split(/\s+/);
          const engineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            engineData.zoom = parseFloat(parts[2]);
          }
          variantShip.engines.push(engineData);
          i++;
          continue;
        }
        
        // Handle reverse engine additions
        if (stripped.startsWith('"reverse engine"') || stripped.startsWith('reverse engine')) {
          hasSignificantChanges = true;
          const parts = stripped.replace(/"/g, '').substring(14).trim().split(/\s+/);
          const reverseEngineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            reverseEngineData.zoom = parseFloat(parts[2]);
          }
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) {
                  break;
                }
                const propStripped = propLine.trim();
                if (propStripped) {
                  reverseEngineData.position = propStripped;
                }
                i++;
              }
              variantShip.reverseEngines.push(reverseEngineData);
              continue;
            }
          }
          
          variantShip.reverseEngines.push(reverseEngineData);
          i++;
          continue;
        }
        
        // Handle steering engine additions
        if (stripped.startsWith('"steering engine"') || stripped.startsWith('steering engine')) {
          hasSignificantChanges = true;
          const parts = stripped.replace(/"/g, '').substring(15).trim().split(/\s+/);
          const steeringEngineData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1])
          };
          if (parts[2]) {
            steeringEngineData.zoom = parseFloat(parts[2]);
          }
          
          if (i + 1 < lines.length) {
            const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
            if (nextIndent > indent) {
              i++;
              while (i < lines.length) {
                const propLine = lines[i];
                const propIndent = propLine.length - propLine.replace(/^\t+/, '').length;
                if (propIndent <= indent) {
                  break;
                }
                const propStripped = propLine.trim();
                if (propStripped) {
                  steeringEngineData.position = propStripped;
                }
                i++;
              }
              variantShip.steeringEngines.push(steeringEngineData);
              continue;
            }
          }
          
          variantShip.steeringEngines.push(steeringEngineData);
          i++;
          continue;
        }
        
        // Handle gun additions
        if (stripped.startsWith('gun ')) {
          hasSignificantChanges = true;
          const parts = stripped.substring(4).trim().split(/\s+/);
          const gunData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1]),
            gun: ""
          };
          variantShip.guns.push(gunData);
          i++;
          continue;
        }
        
        // Handle turret additions
        if (stripped.startsWith('turret ')) {
          hasSignificantChanges = true;
          const parts = stripped.substring(7).trim().split(/\s+/);
          const turretData = {
            x: parseFloat(parts[0]),
            y: parseFloat(parts[1]),
            turret: ""
          };
          variantShip.turrets.push(turretData);
          i++;
          continue;
        }
        
        // Handle bay additions
        if (stripped.startsWith('bay ')) {
          hasSignificantChanges = true;
          const bayMatch = stripped.match(/bay\s+"([^"]+)"\s+([^\s]+)\s+([^\s]+)(?:\s+(.+))?/);
          if (bayMatch) {
            const bayData = {
              type: bayMatch[1],
              x: parseFloat(bayMatch[2]),
              y: parseFloat(bayMatch[3])
            };
            if (bayMatch[4]) {
              bayData.position = bayMatch[4];
            }
            
            if (i + 1 < lines.length) {
              const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
              if (nextIndent > indent) {
                i++;
                while (i < lines.length) {
                  const bayLine = lines[i];
                  const bayLineIndent = bayLine.length - bayLine.replace(/^\t+/, '').length;
                  if (bayLineIndent <= indent) {
                    break;
                  }
                  const bayLineStripped = bayLine.trim();
                  const effectMatch = bayLineStripped.match(/"([^"]+)"\s+"([^"]+)"/);
                  if (effectMatch) {
                    bayData[effectMatch[1]] = effectMatch[2];
                  }
                  i++;
                }
                variantShip.bays.push(bayData);
                continue;
              }
            }
            
            variantShip.bays.push(bayData);
            i++;
            continue;
          }
        }
      }
      
      i++;
    }
    
    // Only return the variant if it has significant changes
    return hasSignificantChanges ? variantShip : null;
  }

  processVariants() {
    console.log(`Processing ${this.pendingVariants.length} ship variants...`);
    
    for (const variantInfo of this.pendingVariants) {
      const variantShip = this.parseShipVariant(variantInfo);
      if (variantShip) {
        this.variants.push(variantShip);
        console.log(`  Added variant: ${variantShip.name}`);
      } else {
        console.log(`  Skipped variant (outfit-only): ${variantInfo.baseName} (${variantInfo.variantName})`);
      }
    }
  } 

  parseOutfit(lines, startIdx) {
    var line = lines[startIdx].trim();
    var match = line.match(/^outfit\s+"([^"]+)"/);
    
    if (!match) {
      return [null, startIdx + 1];
    }
    
    var outfitName = match[1];
    var outfitData = { name: outfitName };
    var descriptionLines = [];
    
    let i = startIdx + 1;
    while (i < lines.length) {
      const currentLine = lines[i];
      if (!currentLine.trim()) {
        i++;
        continue;
      }
      
      const indent = currentLine.length - currentLine.replace(/^\t+/, '').length;
      
      // End of outfit definition
      if (indent === 0 && currentLine.trim()) {
        break;
      }
      
      if (indent === 1) {
        const stripped = currentLine.trim();
        
        // Handle quoted key-value pairs like "cost" 150000
        const quotedMatch = stripped.match(/"([^"]+)"\s+(.+)/);
        if (quotedMatch) {
          const key = quotedMatch[1];
          const valueStr = quotedMatch[2].trim();
          const num = parseFloat(valueStr);
          outfitData[key] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }
        
        // Handle unquoted single-word attributes like: category "Systems"
        const unquotedMatch = stripped.match(/^(\S+)\s+"([^"]+)"$/);
        if (unquotedMatch) {
          const key = unquotedMatch[1];
          outfitData[key] = unquotedMatch[2];
          i++;
          continue;
        }
        
        // Handle unquoted key-value pairs like: mass 40
        const simpleMatch = stripped.match(/^(\S+)\s+(.+)$/);
        if (simpleMatch && !stripped.startsWith('description')) {
          const key = simpleMatch[1];
          const valueStr = simpleMatch[2].trim();
          const num = parseFloat(valueStr);
          outfitData[key] = isNaN(num) ? valueStr : num;
          i++;
          continue;
        }
        
        // Handle description keyword (can use backticks or quotes)
        if (stripped === 'description' || stripped.startsWith('description ')) {
          // Check if description is on the same line (single line)
          const descMatch = stripped.match(/description\s+[`"](.+)[`"]$/);
          if (descMatch) {
            descriptionLines.push(descMatch[1]);
            i++;
            continue;
          }
          
          // Multi-line description starting with backtick or quote on same line
          const startMatch = stripped.match(/description\s+[`"](.*)$/);
          if (startMatch) {
            const startText = startMatch[1];
            // Check if it ends on the same line
            if (startText.endsWith('`') || startText.endsWith('"')) {
              descriptionLines.push(startText.slice(0, -1));
              i++;
              continue;
            }
            // Start of multi-line, add first part
            if (startText) {
              descriptionLines.push(startText);
            }
            i++;
            
            // Continue reading until we find the closing backtick/quote
            while (i < lines.length) {
              const descLine = lines[i];
              const descStripped = descLine.trim();
              
              // Check if this line ends the description
              if (descStripped.endsWith('`') || descStripped.endsWith('"')) {
                const finalText = descStripped.slice(0, -1);
                if (finalText) {
                  descriptionLines.push(finalText);
                }
                i++;
                break;
              }
              
              // Check if we've outdented (shouldn't happen in proper format)
              const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
              if (descIndent <= indent && descLine.trim()) {
                break;
              }
              
              if (descStripped) {
                descriptionLines.push(descStripped);
              }
              i++;
            }
            continue;
          }
          
          // Old format: indented description lines
          i++;
          while (i < lines.length) {
            const descLine = lines[i];
            const descIndent = descLine.length - descLine.replace(/^\t+/, '').length;
            if (descIndent <= indent) {
              break;
            }
            const descStripped = descLine.trim();
            if (descStripped) {
              descriptionLines.push(descStripped);
            }
            i++;
          }
          continue;
        }
        
        // Handle nested blocks (like weapon stats)
        if (i + 1 < lines.length) {
          const nextIndent = lines[i + 1].length - lines[i + 1].replace(/^\t+/, '').length;
          if (nextIndent > indent) {
            const key = stripped.replace(/"/g, '');
            const result = this.parseIndentedBlock(lines, i + 1);
            const nestedData = result[0];
            const nextI = result[1];
            outfitData[key] = nestedData;
            i = nextI;
            continue;
          }
        }
        
        // Single-word attributes (like series name)
        if (!stripped.includes(' ') && !stripped.includes('"')) {
          // This might be description text, collect it
          descriptionLines.push(stripped);
        }
      }
      
      i++;
    }
    
    // Combine description lines
    if (descriptionLines.length > 0) {
      outfitData.description = descriptionLines.join(' ');
    }
    
    return [outfitData, i];
  }

  parseFileContent(content) {
    const lines = content.split('\n');
    let i = 0;
    
    while (i < lines.length) {
      const line = lines[i].trim();
      
      if (line.startsWith('ship "')) {
        const result = this.parseShip(lines, i);
        const shipData = result[0];
        const nextI = result[1];
        if (shipData) {
          // Only add ships that have at least some attributes or hardpoints
          const hasData = shipData.attributes || 
                         shipData.engines.length > 0 || 
                         shipData.guns.length > 0 || 
                         shipData.turrets.length > 0 || 
                         shipData.bays.length > 0;
          if (hasData) {
            this.ships.push(shipData);
          }
        }
        i = nextI;
      } else if (line.startsWith('outfit "')) {
        const result = this.parseOutfit(lines, i);
        const outfitData = result[0];
        const nextI = result[1];
        if (outfitData) {
          this.outfits.push(outfitData);
        }
        i = nextI;
      } else {
        i++;
      }
    }
    
    // Process variants after all base ships are parsed
    this.processVariants();
  }

  async parseRepository(repoUrl) {
    this.ships = [];
    this.variants = [];
    this.outfits = [];
    
    const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${repoUrl}`);
    }
    
    const owner = match[1];
    let repo = match[2].replace('.git', '');
    
    let branch = 'master';
    const branchMatch = repoUrl.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    }
    
    console.log(`Parsing repository: ${owner}/${repo} (branch: ${branch})`);
    
    const files = await this.fetchGitHubRepo(owner, repo, branch);
    
    console.log(`Parsing ${files.length} files...`);
    for (const file of files) {
      this.parseFileContent(file.content);
    }
    
    console.log(`Found ${this.ships.length} ships, ${this.variants.length} variants, and ${this.outfits.length} outfits`);
    
    return {
      ships: this.ships,
      variants: this.variants,
      outfits: this.outfits
    };
  }
}

async function main() {
  try {
    const configPath = path.join(process.cwd(), 'plugins.json');
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    console.log(`Found ${config.plugins.length} plugins to process\n`);
    
    for (const plugin of config.plugins) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing plugin: ${plugin.name}`);
      console.log(`${'='.repeat(60)}`);
      
      const parser = new EndlessSkyParser();
      const data = await parser.parseRepository(plugin.repository);
      
      const pluginDir = path.join(process.cwd(), 'data', plugin.name);
      await fs.mkdir(pluginDir, { recursive: true });
      
      const shipsPath = path.join(pluginDir, 'ships.json');
      await fs.writeFile(shipsPath, JSON.stringify(data.ships, null, 2));
      console.log(`✓ Saved ${data.ships.length} ships to ${shipsPath}`);
      
      const variantsPath = path.join(pluginDir, 'variants.json');
      await fs.writeFile(variantsPath, JSON.stringify(data.variants, null, 2));
      console.log(`✓ Saved ${data.variants.length} variants to ${variantsPath}`);
      
      const outfitsPath = path.join(pluginDir, 'outfits.json');
      await fs.writeFile(outfitsPath, JSON.stringify(data.outfits, null, 2));
      console.log(`✓ Saved ${data.outfits.length} outfits to ${outfitsPath}`);
      
      const combinedPath = path.join(pluginDir, 'complete.json');
      await fs.writeFile(combinedPath, JSON.stringify({
        plugin: plugin.name,
        repository: plugin.repository,
        ships: data.ships,
        variants: data.variants,
        outfits: data.outfits,
        parsedAt: new Date().toISOString()
      }, null, 2));
      console.log(`✓ Saved complete data to ${combinedPath}`);
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('✓ All plugins processed successfully!');
    console.log(`${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = EndlessSkyParser;