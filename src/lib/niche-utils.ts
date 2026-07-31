/** Shared prompt fragment for niche libraries. */
export const IPHONE_SUFFIX =
  'shot on iPhone, natural lighting, neutral color balance, candid unposed realism, subtle contrast, authentic smartphone photography'

export function nichePrompt(scene: string): string {
  return `Ultra realistic 4K photo of a woman ${scene}, ${IPHONE_SUFFIX}.`
}

export interface NicheDefinition {
  id: string
  label: string
  description: string
  /** Only girl-next-door may rotate sub-vibes on one account. */
  rotatable?: boolean
  /** Default hair fragment when assigning this niche to a character. */
  defaultHairLock?: string
  prompts: readonly string[]
}

/** Suggested hair lock text per niche — applied in Admin when niche is selected. */
export const NICHE_HAIR_DEFAULTS: Record<string, string> = {
  'girl-next-door': 'natural soft brown hair in loose waves or messy bun',
  'bunny-pleasure': 'long straight hair with ribbon bow clip, glossy soft curls optional',
  'goth-girl': 'long straight black hair with blunt bangs and dark matte texture',
  'lux-glam': 'sleek voluminous blowout hair, polished glam waves or slick bun',
  'alternative-girl': 'vivid split-dye hair pink and black with shaved undercut',
  'coquette': 'long dark hair with bow accessories and soft romantic curls',
  'e-girl': 'two-tone hair black with bright pink front streaks, winged liner',
  'fitness-baddie': 'high ponytail or slick braid, sporty sleek hair',
  'dark-academia': 'dark brown hair in low messy bun or loose vintage waves',
  'y2k': 'crimped hair with butterfly clips and frosted highlights',
  'clean-girl': 'slicked back low bun or clean middle-part straight hair',
  'cottagecore': 'long wavy auburn hair with wildflower clip or braid',
  'streetwear-baddie': 'long lace-front straight hair with middle part',
  'office-siren': 'dark hair sleek low bun with face-framing layers',
  'festival-girl': 'loose beach waves with glitter roots and braids',
  'punk-rock': 'short choppy mohawk-inspired cut dyed crimson',
  'ballerina-soft': 'tight classical ballet bun with wispy flyaways',
  'cowboy-country': 'long sun-kissed blonde waves under cowboy hat',
  'cyberpunk': 'wet-look asymmetric cut with neon blue tips',
  'mob-wife': 'big voluminous blowout dark hair, retro glam volume',
  'tennis-preppy': 'preppy headband with straight polished ponytail',
  'ski-luxe': 'loose waves peeking from beanie, aprés-ski glow',
  'tattoo-model': 'shaved side long top dyed platinum blonde',
  'vampire-romantic': 'waist-length black hair with blood-red ombré ends',
  'gamer-girl': 'pastel pink gaming headset hair, space buns optional',
  'latina-glam': 'thick voluminous dark curls with golden highlights',
  'maid-aesthetic': 'short bob with headband and ribbon detail',
  'nurse-playful': 'hair in clip-up nurse-cap friendly style',
  'beach-bombshell': 'long honey-blonde beach waves, sun-lightened ends',
  'angel-soft': 'soft platinum waves with halo-lit glow',
  'sorority-girl': 'long straight hair with claw clip, campus-casual center part',
  'pinup-retro': 'victory rolls with red hair scarf, glossy vintage curls',
  'cosplay-con': 'long colorful wig straight with blunt bangs, convention-ready styling',
  'biker-chick': 'long tousled waves under a bandana, windswept from riding',
  'space-vixen': 'sleek silver-white braid with metallic hair cuffs',
  'surfer-girl': 'salt-tousled beach waves sun-bleached at the ends',
  'fairycore': 'loose braided crown with tiny flowers woven through',
  'military-tactical': 'tight slicked bun with camo bandana',
  'bridal-boudoir': 'soft bridal updo with loose face-framing tendrils',
  'trophy-wife': 'glossy blowout with face-framing layers, polished suburban glam',
  'golf-girl': 'sleek ponytail through a visor, polished sporty waves',
  'gymnast': 'tight competition bun with glitter hairspray sheen',
  'hockey-girl': 'tight braid pulled through a helmet cage, ice-rink practical style',
  'volleyball-girl': 'high ponytail with sweatband, sporty practical style',
  'swim-dive': 'wet slicked-back hair, competitive swim-cap ready style',
  'cheerleader': 'high sleek ponytail with team-color ribbon',
  'figure-skater': 'sleek competition bun with sparkling hairpins',
  'dubai-car-girl': 'long sleek glossy blowout, straight and polished with a designer headscarf option',
}

export function getNicheHairDefault(nicheId: string): string {
  return NICHE_HAIR_DEFAULTS[nicheId] ?? ''
}
