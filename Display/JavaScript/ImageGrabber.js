/**
 * GitHub Pages Image Fetcher
 * Extracts and fetches all image paths from game data objects
 */

// Base URL configuration - update this to your GitHub Pages URL
const GITHUB_PAGES_BASE_URL = 'https://GIVEMEFOOD5.github.io/endless-sky-ship-builder/tree/main/data/official-game/images';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

// Cache to store currently loaded images
let currentImageCache = null;

/**
 * Extract all image paths from a data object
 * @param {Object} data - Game data object (outfit, ship, etc.)
 * @returns {string[]} Array of image paths
 */
function extractImagePaths(data) {
  const paths = new Set();

  // Known image path properties to check
  const imageProperties = [
    'sprite',
    'thumbnail',
    'flare sprite',
    'steering flare sprite',
    'reverse flare sprite',
    'hit effect',
    'fire effect',
    'die effect'
  ];

  // Recursive function to search through nested objects
  const searchObject = (obj, parentKey = '') => {
    if (!obj || typeof obj !== 'object') return;

    for (const [key, value] of Object.entries(obj)) {
      // Check if this is a known image property
      if (imageProperties.includes(key)) {
        if (typeof value === 'string') {
          paths.add(value);
        } else if (Array.isArray(value)) {
          value.forEach(v => {
            if (typeof v === 'string') paths.add(v);
          });
        }
      }

      // Special handling for weapon.sprite and other nested sprites
      if (key === 'weapon' && typeof value === 'object') {
        searchObject(value, 'weapon');
      }

      // Check for spriteData (though not an image itself, it's metadata)
      if (key !== 'spriteData' && typeof value === 'object' && !Array.isArray(value)) {
        searchObject(value, key);
      }
    }
  };

  searchObject(data);
  return Array.from(paths);
}

/**
 * Convert a sprite path to full URLs with all possible extensions
 * @param {string} spritePath - Relative sprite path (e.g., 'ship/penguin/penguin')
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @returns {string[]} Array of full URLs to try
 */
function pathToUrls(spritePath, baseUrl = GITHUB_PAGES_BASE_URL) {
  const cleanBaseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  const cleanPath = spritePath.replace(/^\/+/, '');
  
  // If it already has an extension, return just that URL
  if (IMAGE_EXTENSIONS.some(ext => cleanPath.toLowerCase().endsWith(ext))) {
    return [`${cleanBaseUrl}/${cleanPath}`];
  }

  // Otherwise, try all common image extensions
  return IMAGE_EXTENSIONS.map(ext => `${cleanBaseUrl}/${cleanPath}${ext}`);
}

/**
 * Fetch a single image with fallback to different extensions
 * @param {string} spritePath - Relative sprite path
 * @param {string} baseUrl - Base URL for GitHub Pages
 * @returns {Promise<{path: string, url: string, blob: Blob}|null>}
 */
async function fetchImage(spritePath, baseUrl = GITHUB_PAGES_BASE_URL) {
  const urls = pathToUrls(spritePath, baseUrl);

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        return {
          path: spritePath,
          url: url,
          blob: blob
        };
      }
    } catch (error) {
      // Continue to next URL
      continue;
    }
  }

  console.warn(`Failed to fetch image: ${spritePath}`);
  return null;
}

/**
 * Fetch a single image from a sprite path and return an object URL
 * This automatically cleans up previously loaded image when called
 * @param {string} spritePath - Relative sprite path (e.g., 'ship/penguin/penguin')
 * @param {Object} options - Options
 * @param {string} options.baseUrl - Base URL for GitHub Pages (optional)
 * @returns {Promise<string|null>} Object URL for the image, or null if failed
 */
async function fetchSpriteImage(spritePath, options = {}) {
  const { baseUrl = GITHUB_PAGES_BASE_URL } = options;
  
  // Clean up previous image before loading new one
  clearCurrentImages();
  
  if (!spritePath) {
    console.warn('No sprite path provided');
    return null;
  }

  console.log(`Fetching image: ${spritePath}`);

  const result = await fetchImage(spritePath, baseUrl);
  
  if (result && result.blob) {
    const objectUrl = URL.createObjectURL(result.blob);
    
    // Store in cache for automatic cleanup
    currentImageCache = { [spritePath]: objectUrl };
    
    return objectUrl;
  }

  return null;
}

/**
 * Clear currently loaded images (call this when switching tabs)
 * This is automatically called when fetchSpriteImage is called again
 */
function clearCurrentImages() {
  if (currentImageCache) {
    Object.values(currentImageCache).forEach(url => URL.revokeObjectURL(url));
    currentImageCache = null;
    console.log('Cleared previous image from memory');
  }
}

// When switching modal tabs, the cleanup happens automatically:
// 1. User clicks on "Sprite" tab → fetchSpriteImage('ship/penguin/penguin') loads the image
// 2. User clicks on "Thumbnail" tab → fetchSpriteImage('thumbnail/penguin') automatically cleans up the sprite and loads thumbnail
// 3. User closes modal → call clearCurrentImages() to clean up

// Update My closeModal function:
function closeModal() {
    clearCurrentImages(); // Clean up images when closing modal
    document.getElementById('detailModal').classList.remove('active');
}

// Or if I want to manually clear when switching between items:
// clearCurrentImages();

//export { fetchSpriteImage, clearCurrentImages, extractImagePaths };

// Make functions globally accessible for HTML onclick attributes
window.clearCurrentImages = clearCurrentImages;
window.fetchSpriteImage = fetchSpriteImage;
window.extractImagePaths = extractImagePaths;
