/**
 * Branded niche full-feed prompt sets — one niche ≈ one account identity.
 */

import type { NicheDefinition } from './niche-utils'
import { IPHONE_SUFFIX } from './niche-utils'
import { EXTRA_NICHE_DEFINITIONS } from './niches/extra-niches'

export type { NicheDefinition } from './niche-utils'
export { NICHE_HAIR_DEFAULTS, getNicheHairDefault } from './niche-utils'

const IPHONE = IPHONE_SUFFIX

export const CORE_NICHE_DEFINITIONS: NicheDefinition[] = [
  // ─── Girl Next Door (rotatable) ───────────────────────────────
  {
    id: 'girl-next-door',
    label: 'Girl Next Door',
    rotatable: true,
    defaultHairLock: 'natural soft brown hair in loose waves or messy bun',
    description:
      'Soft, relatable, cozy everyday — sundresses, messy buns, coffee runs, sunlit apartments. Can rotate sub-vibes on one account.',
    prompts: [
      `Ultra realistic 4K photo of a woman with a soft natural look, standing barefoot on a sunlit apartment balcony in a loose white cotton sundress, holding a ceramic mug with both hands, gentle sleepy smile, hair in a messy low bun with loose face-framing strands, small gold hoop earrings, potted plants and warm morning haze in the background, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sitting cross-legged on a cream linen sofa, oversized oatmeal knit sweater slipping off one shoulder, bare legs tucked under her, laughing mid-conversation while looking toward camera, warm window light, unmade throw blanket, lived-in cozy living room, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman leaning against a kitchen counter in high-waisted light-wash jeans and a fitted white tank top, stirring honey into tea, soft natural smile, hair in a claw clip, sun streaks across minimal white cabinets, fresh fruit bowl nearby, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman walking through a farmer's market holding a paper bag of flowers, flowy floral midi skirt and simple white tee, straw tote on shoulder, candid mid-step expression, golden hour warmth, blurred market stalls behind her, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying on her stomach on a bed with white rumpled sheets, chin propped on hands, reading a paperback, oversized vintage band tee and cotton shorts, soft afternoon light through sheer curtains, relaxed intimate bedroom mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on a park bench eating ice cream from a cup, casual denim jacket over a ribbed tank, hair down with natural waves, genuine laugh with eyes slightly closed, green trees and dappled sunlight, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in a bathroom mirror selfie, wet hair wrapped in a towel, dewy bare-face skincare moment, simple ribbed tank, steam-softened light, toothbrush and skincare bottles on counter, authentic morning routine, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman riding a bicycle on a quiet tree-lined street, light linen dress fluttering slightly, basket with a baguette and flowers, carefree expression, late-afternoon glow, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling on a picnic blanket in a meadow, pouring lemonade into a glass, gingham dress, soft breeze lifting hair, open book and sunglasses beside her, dreamy summer afternoon, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at a rainy window seat in a café, hands wrapped around a latte, oversized cardigan, gazing out with thoughtful soft expression, raindrops on glass, warm interior bokeh, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman stretching on a yoga mat in a bright apartment, matching soft pastel set, hair in a high ponytail, calm focused expression, plants and morning sun, healthy everyday routine, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman baking in a kitchen, flour on cheek, rolling dough on wooden board, casual apron over tank and shorts, warm oven light, candid joyful smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on front porch steps at dusk, denim shorts and fitted tee, holding a glass of iced tea, string lights beginning to glow, relaxed end-of-day mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in a bookstore aisle, pulling a book from shelf, oversized sweater and leggings, profile glance toward camera with curious smile, warm ambient store lighting, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman drying hair with towel after shower, soft robe loosely tied, bathroom mirror fog, natural no-makeup glow, intimate candid routine moment, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on a rooftop at golden hour, wind in loose hair, simple slip dress and denim jacket draped on shoulders, city skyline soft blur, peaceful smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman painting nails on couch edge, cropped tee and lounge shorts, TV glow in background, casual lazy Sunday energy, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman hugging a pillow on bed, oversized sleep shirt, soft sleepy expression, morning light band across face, intimate cozy mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at a casual outdoor brunch table, linen co-ord set, sunglasses pushed into hair, mid-bite forkful with playful smile, bright patio setting, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman tying sneakers on apartment floor, matching soft activewear set, hair in braided pigtails, ready-for-a-walk energy, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman holding a kitten close to cheek, cozy knit sweater, genuine delighted expression, soft indoor window light, wholesome candid moment, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in a sunflower field at sunset, simple white dress, hair blowing freely, eyes closed with peaceful smile, warm backlit glow, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman journaling at desk by window, cardigan over camisole, pen paused mid-thought, soft reflective mood, cup of tea steaming, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman dancing alone in kitchen, wireless earbuds in, oversized tee and shorts, mid-movement hair swing, joyful unguarded laugh, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on beach at low tide, rolled-up jeans and striped tee, bare feet in sand, collecting shells, soft overcast light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in thrift-store mirror, trying on vintage denim jacket, playful unsure expression, cluttered colorful racks behind, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman watering plants on fire escape, ribbed tank and lounge pants, hair in messy braid, urban greenery, late morning haze, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman wrapped in blanket on couch watching movie, bowl of popcorn, fuzzy socks, content relaxed smile, dim cozy lamp light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at open refrigerator late night, soft fridge glow on face, oversized tee, playful guilty snack expression, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on suburban sidewalk with coffee, athleisure set, ponytail through cap, fresh post-walk glow, crisp morning, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman arranging flowers in mason jar, simple tank and jeans, focused gentle expression, kitchen table clutter, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on swing set at empty playground, casual sundress, hair flowing backward mid-swing, nostalgic carefree laugh, golden hour, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman doing face mask on bed, headband holding hair back, robe open over pajama set, spa-night-at-home vibe, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman leaning on car hood in driveway, casual tee tucked into jeans, keys in hand, about-to-leave candid smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at laundromat sitting on washer, denim on denim, scrolling phone with bored cute expression, fluorescent mixed with window light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on front lawn with hose watering grass, shorts and tank, sun hat pushed back, playful summer chore moment, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman under fairy lights on bedroom wall, soft camisole and shorts, lying on stomach kicking feet, dreamy intimate smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at donut shop counter, paper bag in hand, casual crop hoodie, excited treat-day expression, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on hiking trail pause, windbreaker tied at waist, sports bra visible, hair in practical braid, proud accomplished smile, mountain backdrop, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman painting watercolor at kitchen table, paint-stained fingers, messy bun with pencil stuck through, absorbed creative moment, ${IPHONE}.`,
    ],
  },

  // ─── Bunny / Submissive Pleasure Girl ─────────────────────────
  {
    id: 'bunny-pleasure',
    label: 'Bunny Pleasure Girl',
    defaultHairLock: 'long straight hair with ribbon bow clip, glossy soft curls optional',
    description:
      'Branded playful submissive aesthetic — bunny ears, ribbons, lace, soft pink-and-black bedroom sets, doe eyes, plush intimacy.',
    prompts: [
      `Ultra realistic 4K photo of a woman kneeling on a plush white rug, wearing black lace lingerie set with satin ribbon choker and fluffy bunny ear headband, hands resting on thighs, soft upward gaze, pink LED ambient glow, velvet headboard and scattered plush toys, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sitting on bed edge in pink satin robe falling open over lace bodysuit, bunny ears slightly tilted, biting lower lip playfully, fairy lights and rose petals on sheets, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying on stomach on pink silk sheets, legs bent upward, lace thigh bands and ribbon ankle ties, chin on folded arms, teasing smile toward camera, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in doorway on knees, oversized unbuttoned white shirt over black lingerie, bunny ears and collar with small bell, warm hallway light silhouette, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman holding stuffed bunny against chest, sheer babydoll dress, glossy lips and soft blush, bedroom mirror reflections, intimate pastel boudoir, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman arched back on chaise lounge, harness-style lace details, ribbon bows at hips, eyes half-lidded, candlelight and dark velvet drapes, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on all fours on bed looking over shoulder, fishnet stockings and bunny tail accessory, lace gloves, moody pink and purple lighting, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sitting in bubble bath, foam covering chest, bunny ears headband dry above waterline, wet hair slicked back, candles on tub edge, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling before vanity mirror applying lip gloss, lace bralette and silk shorts, collar with heart pendant, soft ring-light glow, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sprawled on fur throw, red lace set with white bunny ears, one knee raised, playful obedient expression, dark romantic bedroom, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman standing with wrists loosely bound in satin ribbon, sheer robe slipping off shoulders, bunny ears, submissive soft smile, window backlight, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman curled on window seat in oversized pink hoodie and lace shorts, bunny slippers, holding mug, innocent contrast mood, rain outside, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on knees leaning forward elbows on ottoman, leather collar and leash draped loosely on floor unused, lace bodysuit, direct inviting gaze, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying sideways on pink bed, one strap falling off shoulder, bunny ear headband, finger tracing lip, neon sign glow reading love, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in closet mirror selfie, full lace ensemble with garter straps, bunny ears, phone partially visible, warm bulb string lights, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman seated on floor back against bed, knees up, ribbon tied around ankles decoratively, soft pout, scattered rose petals, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman bending forward adjusting bunny ear headband, cleavage framed by black lace bra, hair in high ponytail with ribbon, bedroom warm lamp, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on silk pillows, blindfold pushed up on forehead, lace mask at neck, playful surprised expression, pink ambient LED strips, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling on chair facing backrest, lace teddy and thigh highs, bunny ears, looking back over shoulder, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman under sheer canopy bed curtains, white lace set, collar with bow, fingers pulling ribbon on thigh, soft diffused daylight, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman hugging knees on bed, oversized bunny onesie partially unzipped at chest, vulnerable sweet expression, plush room decor, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on vanity stool legs spread slightly, applying perfume to neck, sheer robe open, bunny ears, glossy skin highlights, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying on back arms above head, wrists in fuzzy cuffs, pink and black lace, euphoric soft smile, ceiling mirror reflection, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman crawling across bed toward camera, bunny ears and tail set, lace lingerie, playful predator-prey tease energy, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling in bathtub dry, bubble skirt of foam around waist, wet skin sheen, bunny ears, innocent yet suggestive gaze, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on leather bench, latex and lace mixed outfit, collar attached to chain on floor, confident submissive poise, red light accent, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sitting sideways on piano bench in lingerie and robe, bunny ears, fingers on keys, artistic boudoir mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman peeking from behind door, lace bodysuit, one bunny ear visible, shy inviting glance, hallway warm light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on knees hands clasped under chin, doll-like makeup, ribbon choker, pastel bedroom full of plush bunnies, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman sprawled on couch, fishnets ripped artistically, bunny ears askew, lazy satisfied expression, TV glow, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman standing tiptoe reaching high shelf, short silk chemise riding up, bunny slippers, candid domestic boudoir, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in egg chair, knees drawn up, lace bodysuit, collar bell visible, reading spicy novel, lamp glow, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on rug before fireplace, fur throw over shoulders falling open, lingerie beneath, bunny ears, winter intimate mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying on stomach feet up, writing in diary, lace cami and shorts, bunny ear headband, secretive smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at dressing table, fixing bunny ears in mirror, red lace set, lipstick stain on glass nearby, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling on plush pink carpet, harness lingerie, ribbon gag held in hand not worn, teasing eye contact, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in doorframe silhouette, sheer curtain backlit, bunny ears profile, hands on frame above head, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on bed surrounded by rose petals heart shape, white lace set, bunny ears, arms extended welcoming, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lounging in hotel room, black silk sheets, pink bunny ears, champagne glass untouched, luxury boudoir travel set, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on yoga ball substitute plush ottoman, playful balance pose in lingerie, bunny tail, laughing expression, ${IPHONE}.`,
    ],
  },

  // ─── Goth Girl ────────────────────────────────────────────────
  {
    id: 'goth-girl',
    label: 'Goth Girl',
    defaultHairLock: 'long straight black hair with blunt bangs and dark matte texture',
    description:
      'Dark romantic brand — black lace, platform boots, dramatic makeup, cemetery rain, candles, velvet, industrial nights.',
    prompts: [
      `Ultra realistic 4K photo of a woman standing in misty cemetery at dusk, long black lace dress with bell sleeves, platform combat boots, silver cross choker, sharp winged eyeliner, pale matte lips, hands clasped holding dried roses, gothic overcast sky, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman seated on ornate stone angel monument, fishnet tights under ripped skirt, leather jacket, spiked bracelet, staring directly at camera with melancholic intensity, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman by rainy window, black velvet corset top and maxi skirt, candle reflections on glass, wet hair strands on cheek, moody blue hour light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in abandoned church aisle, lace gloves, dramatic black hat, corset lacing visible, stained glass color cast on skin, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on urban rooftop at night, mesh top under harness, cargo pants with chains, neon sign red glow on face, cigarette unused in hand, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying on black satin bedspread, Victorian-style lace dress, crucifix necklace, candles on nightstand, overhead moody shot, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in record store aisle, band tee cropped, plaid skirt, thick platform boots, septum ring and dark lipstick, browsing vinyl with bored cool expression, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on bridge in fog, long coat open over lace bodysuit, thigh-high boots, hair wind-swept, cinematic gothic atmosphere, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at vanity with cracked antique mirror, applying black lipstick, lace robe falling off shoulders, skull decor and dried flowers, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman kneeling in shallow stream in forest, wet black dress clinging, crown of dark flowers, ethereal dark-fairy mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in industrial warehouse, latex skirt and mesh top, buckled choker, harsh single spotlight, concrete and rust backdrop, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on spiral staircase, gothic lolita inspired black dress, knee socks and platforms, hand on railing looking down, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in botanical greenhouse at night, black lace dress among overgrown plants, moon through glass panels, mysterious calm, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman leaning on motorcycle, leather pants and lace bustier, dark smokey eyes, chain belt, garage dim bulbs, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman reading tarot at small table, velvet dress, rings on multiple fingers, candle cluster, occult aesthetic apartment, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in art gallery corner, avant-garde black sculptural outfit, bleached brows and dark lip, contemptuous art-girl stare, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on subway platform alone, long black coat, fishnets, headphones around neck, fluorescent grim aesthetic, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in bathtub with black water tint, floating petals, lace bralette visible at waterline, candles everywhere, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at gravestone sitting, black midi dress slit, platform Mary Janes, holding single white lily, overcast soft light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in mirror hallway, full black ensemble with silver chains, sharp contour makeup, multiple mirror recursion, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on fire escape city night, bat wing eyeliner, mesh dress over bodysuit, city bokeh below, wind in dark hair, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in library stacks, gothic academic look, turtleneck lace dress, round glasses chain, ancient books, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at bar stool, black latex top, velvet choker, drink with cherry, red neon sign reflection, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in cornfield at twilight, unexpected contrast black lace against dry stalks, crow on fence post background, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on piano in abandoned mansion, torn lace gown, dust motes in light beam, dramatic side profile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman under umbrella in rain on cobblestone street, long black coat, red lipstick stark contrast, noir mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in tattoo studio chair post-session, bandage on rib area, black bralette and joggers, proud dark-aesthetic smile, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on cliff edge ocean behind, black flowing dress wind dramatic, silver jewelry, storm clouds gathering, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in candle shop aisle, holding black taper candles, lace blouse and skirt, warm orange glow on face, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on bed frame sitting, harness over mesh shirt, plaid skirt, spiked collar, posters on wall, bedroom goth nest, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at museum marble statue, mimicking pose ironically, black avant-garde outfit, cool detached expression, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in foggy park bench, Victorian inspired black coat, cameo brooch, holding antique locket, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in elevator mirror, full goth glam makeup, black sequin dress, going to night event, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on crossroads at night, leather trench, lace tights, streetlamp halo, cinematic horror-romance vibe, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in greenhouse of dead dried flowers, black dress, holding withered bouquet, beauty-in-decay theme, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at organ in old chapel, long sleeves lace dress, hands on keys, stained light, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on motorcycle back seat turned toward camera, all black outfit, night ride wind, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in snow outside, black fur coat over lace dress, breath visible, stark white-black contrast, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman lying in autumn leaves, black romper, dark berry lips, leaves stuck in hair, seasonal goth, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at pier at midnight, platform boots on wet wood, long coat, moon path on water, ${IPHONE}.`,
    ],
  },

  // ─── Lux Glam Girl ────────────────────────────────────────────
  {
    id: 'lux-glam',
    label: 'Lux Glam Girl',
    defaultHairLock: 'sleek voluminous blowout hair, polished glam waves or slick bun',
    description:
      'High-glam luxury brand — designer energy, marble suites, champagne, diamonds, full beat makeup, red carpet, private jet aesthetic.',
    prompts: [
      `Ultra realistic 4K photo of a woman in penthouse suite floor-to-ceiling windows at night, floor-length black satin gown with thigh slit, diamond earrings and cuff bracelet, champagne flute in hand, city skyline bokeh, flawless glam makeup, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman stepping out of black luxury car, white fur stole over sequin mini dress, stiletto heel on pavement, paparazzi-style flash simulation, confident power gaze, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at marble bathroom vanity, robe open on silk slip dress, doing final lipstick touch, jewelry tray with gold and diamonds, soft vanity bulbs, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on private jet leather seat, tailored cream blazer dress, legs crossed, designer handbag beside, sunglasses indoors, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on yacht deck sunset, gold bikini under sheer kaftan, layered necklaces, champagne on ice bucket nearby, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in hotel lobby, bodycon emerald dress, slicked hair bun, statement earrings, walking mid-stride, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at rooftop pool infinity edge, white one-piece high-cut, wide-brim hat and oversized shades, luxury resort, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in boutique fitting room, trying couture gown, assistant hands invisible, mirror glow, excited elite shopper mood, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at fine dining table, off-shoulder black dress, pearl choker, candle between, holding wine glass stem, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on spiral luxury staircase, red carpet gown train flowing, diamond drop earrings, gala entrance moment, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in walk-in closet, surrounded by designer bags on shelves, silk loungewear set, selecting heels, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at casino high-limit room, velvet dress, poker chips stacked, smoky eye makeup, confident smirk, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on balcony breakfast tray, oversized designer shirt as dress, messy glam waves, croissants and coffee, morning luxury, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in spa white robe, cucumber water nearby, fresh facial glow, diamond stud earrings only, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at art auction room, tailored jumpsuit, clutch purse, bidding paddle raised, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in limousine back seat, latex-sheen dress under coat, city lights streak through tinted window, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on tennis court luxury club, white tennis skirt set designer, visor and sweat glow editorial, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at perfume counter, testing scent on wrist, silk blouse, gold watch stack, department store glam, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on beach cabana white drapes, gold jewelry layered, designer swim set, prosecco bucket, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in elevator gold-mirror walls, mini dress and blazer, phone selfie angle, going out makeup, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at piano bar, red satin dress, martini on piano, lounge singer aesthetic, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on shopping street carrying multiple boutique bags, oversized sunglasses, latte in hand, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in ski lodge luxury, faux fur coat over bodysuit, hot cocoa by fireplace, après-ski glam, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at makeup campaign style close-up, dewy highlight, glossy lips, diamond nose stud, studio softbox mimic, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on helipad, wind in hair, tailored coat dress, arriving by helicopter fantasy, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in garden party, floral couture gown, fascinator hat, champagne garden event, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at jewelry store glass case, trying tennis bracelet, slip dress, consultant hands out of frame, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on desert resort dunes shoot, gold dress catching sunset, editorial high-fashion pose, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in steam room glass door, white bikini, water droplets, luxury spa marble, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at nightclub VIP rope, metallic dress, bodyguard blur background, exclusive entrance, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on classic convertible hood sitting, headscarf and oversized sunglasses, old money summer, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in crown suite bed, silk pajama set designer, breakfast in bed tray, morning after gala, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at gala step-and-repeat wall, gown with train, posing hand on hip, event branding blur, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in cigar lounge allowed unlit prop, power suit unbuttoned at collar, whiskey glass, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on Mediterranean terrace lunch, linen co-ord designer, big hat, turquoise sea behind, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at coat check, fur wrap being placed on shoulders, evening gown, valet lights, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in bathroom steam post-shower, towel wrap, jewelry still on, glam intact, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman on city crosswalk confident stride, monochromatic beige luxury set, structured bag, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman at New Year's balcony fireworks, sequin dress, sparkler in hand, celebration glam, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman in private gallery viewing, cocktail dress, contemplating large canvas, collector mood, ${IPHONE}.`,
    ],
  },

  // ─── Alternative Girl ─────────────────────────────────────────
  {
    id: 'alternative-girl',
    label: 'Alternative Girl',
    defaultHairLock: 'vivid split-dye hair pink and black with shaved undercut',
    description:
      'Full alternative brand — split dye or vivid hair, piercings, tattoos, band tees, platforms, graffiti, skate parks, chaotic layers.',
    prompts: [
      `Ultra realistic 4K photo of a woman with vivid split-dye hair pink and black, septum ring and ear cuff stack, cropped band tee over lace bralette, plaid mini skirt, platform combat boots, leaning on graffiti wall, confident edgy stare, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with shaved undercut and long neon green top layer, arm tattoo sleeves visible, mesh top under leather vest, ripped jeans, sitting on skateboard in empty pool, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with bright blue mullet haircut, nose stud and brow piercing, oversized vintage hoodie, fishnet sleeves, drinking energy drink on convenience store curb at night, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with cherry red pigtails and dark roots, chain belt on cargo pants, band patch jacket, tuning electric guitar on bed, poster-covered room, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with purple shag cut, multiple ear piercings, slip dress over graphic long sleeve, platform Mary Janes, record store crate digging, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with bleached buzz cut growing out dark roots, tattoo choker and chest piece visible, sports bra and baggy joggers, gym alternative vibe, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with hot pink wolf cut, safety pin earrings, torn band shirt knotted, leather mini and striped thigh highs, alley neon signs, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with turquoise braided extensions, lip ring, oversized flannel open on corset top, skater shoes, ramp park background, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with jet black hair electric yellow streaks, industrial piercings, latex pants and band tee, warehouse party lights, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with messy bleached fringe and dark long back, stick-and-poke style finger tattoos, beanie and layered chains, smoking area outside venue unused cigarette prop, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with orange space buns and undercut designs, holographic jacket, mini backpack, festival wristbands, outdoor concert field, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with long straight white-blond hair dark roots, snake bite piercings, velvet dress unexpected soft alt, cemetery photoshoot day version, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with crimson dip-dye ends, tattoo leg sleeve, denim vest patches, holding vintage film camera, urban rooftop, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with half-shaved head geometric pattern, multiple face piercings subtle, structured blazer over hoodie, art school campus, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with pastel pink bob and dark eyebrows, ear gauges, oversized sweater off one shoulder, thrift store mirror, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with green-black ombré waves, chain harness over mesh, vinyl pants, nightclub bathroom neon, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with spiked choker and mohawk-inspired short cut dyed magenta, leather jacket painted custom, motorcycle in background, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with long black hair pink bangs only, tattoo sternum piece, ribbed tank and low-rise baggy jeans, gas station night lights, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with braided crown and loose blue lengths, nose chain jewelry, crochet top and maxi skirt alt-festival, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with slick wet-look black hair red tips, pierced eyebrow, basketball jersey dress over fishnets, street court, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with voluminous curly auburn with bleached streaks, tattoo sleeve floral, romper and platform sandals, rooftop garden urban, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with short lilac pixie cut, multiple helix piercings, oversized blazer no shirt visible beneath, cigarette pants, gallery opening alt, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with waist-length black hair electric blue ends, spider web elbow tattoo, gothic-alt crossover mesh dress, bridge at dusk, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with high ponytail wrapped in bandana, lip ring and dimple piercings, sports luxe alt set, basketball hoop playground, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with shaved sides long top slicked back, ear tattoo visible, denim on denim patched, mechanic garage aesthetic, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with bubblegum pink shoulder-length shag, heart-shaped sunglasses, baby tee and cargo maxi, bubble gum blowing, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with black locs dyed gold tips, nose ring and labret, oversized vintage sports jersey, roller rink, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with choppy blonde-black two-tone bob, tattoo neck piece, slip skirt and combat boots mix, laundromat neon, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with long straight hair half pink half black vertical split, pierced septum, corset top and baggy cargos, subway stairs, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with teased 80s-inspired alt hair purple, geometric earrings, metallic top and leather pants, retro arcade, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with buzzed sides long mohawk braid dyed red, tattoo hand pieces, tube top and parachute pants, skate trick pause, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with silver-grey pixie and dark brows, multiple nose piercings, androgynous suit alt tailoring, crosswalk, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with wild curly hair half bleached, daisy chain in hair alt-soft, crochet set, meadow unexpected alt, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with black hair neon orange bangs, tattoo rib script, hockey jersey dress, bleachers empty stadium, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with long wavy hair pastel rainbow tint, ear cuff ladder, fairy grunge alt dress layers, forest path, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with spiky short cut gelled blue, bridge piercing, oversized coat and shorts, bus stop rain, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with hip-length straight hair vivid red, back tattoo visible in low-back top, mini skirt and platforms, comic shop, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with twisted updo and loose dyed strands, safety pin makeup detail, deconstructed shirt dress, art installation background, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with fluffy wolf cut teal, stretched ear lobes with ornate plugs, halter top and wide jeans, pier parlor waiting chair, ${IPHONE}.`,
      `Ultra realistic 4K photo of a woman with slick bob black to white gradient, tattoo collarbone quote, racing jacket and mini, parking garage fluorescent, ${IPHONE}.`,
    ],
  },
]

export const NICHE_DEFINITIONS: NicheDefinition[] = [
  ...CORE_NICHE_DEFINITIONS,
  ...EXTRA_NICHE_DEFINITIONS,
]

export function getNicheById(id: string): NicheDefinition | undefined {
  return NICHE_DEFINITIONS.find(n => n.id === id)
}

export function resolveNichePrompts(nicheId: string): string[] {
  const niche = getNicheById(nicheId)
  return niche ? [...niche.prompts] : []
}

/** Tags for prompt_library when saving a niche full feed. */
export function nicheLibraryTags(nicheId: string): string[] {
  return ['static-bundle', 'niche', `niche-${nicheId}`, 'full-feed']
}

export function nicheAiLibraryTags(nicheId: string): string[] {
  return ['grok-generated', 'niche', `niche-${nicheId}`, 'full-feed']
}
