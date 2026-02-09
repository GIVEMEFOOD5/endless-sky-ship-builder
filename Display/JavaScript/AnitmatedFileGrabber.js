/**
 * Image Variation Fetcher
 * Finds images with variation patterns (+, ~, -, ^, =, @ followed by numbers)
 * This file only handles fetching - no display logic
 */

// Base URL configuration
const GITHUB_PAGES_BASE_URL = 'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/data/official-game/images';
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

/**
 * Convert a sprite path to full URLs with all possible extensions
 * @param {string} spritePath - Relative sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @returns {string[]} Array of full URLs to try
 */
function pathToUrls(spritePath, baseUrl = GITHUB_PAGES_BASE_URL) {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  const cleanPath = spritePath.replace(/^\/+/, '');
  
  if (IMAGE_EXTENSIONS.some(ext => cleanPath.toLowerCase().endsWith(ext))) {
    return [`${cleanBaseUrl}/${cleanPath}`];
  }

  return IMAGE_EXTENSIONS.map(ext => `${cleanBaseUrl}/${cleanPath}${ext}`);
}

/**
 * Fetch a single image with fallback to different extensions
 * @param {string} spritePath - Relative sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @returns {Promise<{path: string, url: string, blob: Blob}|null>}
 */
async function fetchSingleImage(spritePath, baseUrl = GITHUB_PAGES_BASE_URL) {
  const urls = pathToUrls(spritePath, baseUrl);

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        return { path: spritePath, url: url, blob: blob };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

/**
 * Find all similar images with variation patterns
 * @param {string} basePath - Base sprite path (e.g., 'ship/penguin')
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @param {Object} options - Options
 * @param {number} options.maxVariations - Maximum number of variations to check (default: 20)
 * @param {string[]} options.separators - Array of separator characters (default: ['+', '~', '-', '^', '=', '@'])
 * @returns {Promise<Array<{path: string, url: string, blob: Blob, variation: string}>>}
 */
async function findImageVariations(basePath, baseUrl = GITHUB_PAGES_BASE_URL, options = {}) {
  const {
    maxVariations = 20,
    separators = ['+', '~', '-', '^', '=', '@']
  } = options;

  const foundImages = [];
  const cleanPath = basePath.replace(/^\/+/, '');

  console.log(`Searching for variations of: ${cleanPath}`);

  // Try base path first
  const baseImage = await fetchSingleImage(cleanPath, baseUrl);
  if (baseImage) {
    foundImages.push({
      ...baseImage,
      variation: 'base'
    });
  }

  // Try each separator with numbers
  for (const separator of separators) {
    for (let i = 0; i < maxVariations; i++) {
      const variationPath = `${cleanPath}${separator}${i}`;
      const urls = pathToUrls(variationPath, baseUrl);

      let foundVariation = false;
      for (const url of urls) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const blob = await response.blob();
            foundImages.push({
              path: variationPath,
              url: url,
              blob: blob,
              variation: `${separator}${i}`
            });
            foundVariation = true;
            console.log(`Found variation: ${variationPath}`);
            break;
          }
        } catch (error) {
          continue;
        }
      }

      // Stop if we hit a gap (assumes sequential numbering)
      if (!foundVariation && i > 0) {
        break;
      }
    }
  }

  console.log(`Found ${foundImages.length} total images for ${cleanPath}`);
  return foundImages;
}

/**
 * Get just the list of variation paths that exist (no downloading)
 * @param {string} basePath - Base sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @param {Object} options - Same options as findImageVariations
 * @returns {Promise<string[]>} Array of paths that exist
 */
async function listVariationPaths(basePath, baseUrl = GITHUB_PAGES_BASE_URL, options = {}) {
  const images = await findImageVariations(basePath, baseUrl, options);
  return images.map(img => img.path);
}

/**
 * Check if variations exist for a given path
 * @param {string} basePath - Base sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @param {Object} options - Same options as findImageVariations
 * @returns {Promise<boolean>} True if variations exist (more than just base)
 */
async function hasVariations(basePath, baseUrl = GITHUB_PAGES_BASE_URL, options = {}) {
  const paths = await listVariationPaths(basePath, baseUrl, options);
  return paths.length > 1;
}

/**
 * Get count of variations
 * @param {string} basePath - Base sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @param {Object} options - Same options as findImageVariations
 * @returns {Promise<number>} Number of variations found
 */
async function getVariationCount(basePath, baseUrl = GITHUB_PAGES_BASE_URL, options = {}) {
  const paths = await listVariationPaths(basePath, baseUrl, options);
  return paths.length;
}

// Make functions globally accessible
window.findImageVariations = findImageVariations;
window.listVariationPaths = listVariationPaths;
window.hasVariations = hasVariations;
window.getVariationCount = getVariationCount;
