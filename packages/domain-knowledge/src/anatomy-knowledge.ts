/**
 * DACAIS Anatomical, Animal, and Spatial Entity Knowledge Engine.
 *
 * Provides authoritative ground truth for:
 * 1. Human male and female anatomy, regional landmarks, normalized coordinates,
 *    directional relations, and sexually dimorphic morphology.
 * 2. Comparative animal anatomy across quadrupeds and avians.
 * 3. Spatial grounding for objects, places, environments, and physical entities.
 */

export type AnatomicalGender = 'female' | 'male' | 'neutral' | 'comparative-animal';

export type AnatomicalPlane = 'sagittal' | 'coronal' | 'transverse' | 'oblique';

export type DirectionalTerm =
  | 'superior'
  | 'inferior'
  | 'anterior'
  | 'posterior'
  | 'medial'
  | 'lateral'
  | 'proximal'
  | 'distal'
  | 'superficial'
  | 'deep'
  | 'cranial'
  | 'caudal'
  | 'dorsal'
  | 'ventral';

export type BodySystem =
  | 'skeletal'
  | 'muscular'
  | 'integumentary'
  | 'nervous'
  | 'cardiovascular'
  | 'respiratory'
  | 'digestive'
  | 'urogenital'
  | 'endocrine'
  | 'lymphatic'
  | 'surface-anatomy';

export interface NormalizedBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AnatomicalLandmark {
  id: string;
  name: string;
  aliases: readonly string[];
  system: BodySystem;
  genderSpecificity: AnatomicalGender;
  primaryRegion: 'head' | 'cervical' | 'thorax' | 'abdomen' | 'pelvis' | 'upper_extremity' | 'lower_extremity' | 'dorsal';
  subRegion: string;
  canonicalCoordinates: {
    /** Normalized bounding coordinates (0..1) on standard frontal / anterior view. */
    anterior?: NormalizedBoundingBox;
    /** Normalized bounding coordinates (0..1) on standard dorsal / posterior view. */
    posterior?: NormalizedBoundingBox;
    /** Normalized bounding coordinates (0..1) on standard lateral profile view. */
    lateral?: NormalizedBoundingBox;
  };
  depthLayer: 'superficial' | 'intermediate' | 'deep';
  adjacentStructures: readonly string[];
  relativePlacement: string;
  description: string;
  dimorphicFeatures?: {
    female?: string;
    male?: string;
  };
}

export type AnimalTaxon = 'canine' | 'feline' | 'equine' | 'bovine' | 'avian' | 'general_quadruped';

export interface AnimalAnatomyLandmark {
  id: string;
  taxon: AnimalTaxon;
  name: string;
  aliases: readonly string[];
  bodyPlan: 'quadruped' | 'biped_avian' | 'marine';
  region: 'cranial' | 'cervical' | 'thoracic_dorsal' | 'flank_abdomen' | 'pelvic_rump' | 'forelimb' | 'hindlimb' | 'caudal_tail';
  canonicalCoordinates?: NormalizedBoundingBox;
  relativePlacement: string;
  homologueToHuman: string;
  description: string;
}

export interface ObjectPlaceEntity {
  id: string;
  category: 'object' | 'place' | 'thing';
  name: string;
  aliases: readonly string[];
  subCategory: string;
  keyComponents: readonly string[];
  spatialStructure: string;
  visualProperties: readonly string[];
}

export interface AnatomicalQueryResult {
  found: boolean;
  landmark?: AnatomicalLandmark;
  comparativeAnimal?: AnimalAnatomyLandmark;
  matchedBy?: 'exact' | 'alias' | 'fuzzy';
  query: string;
}

// ---------------------------------------------------------------------------
// HUMAN ANATOMICAL REGISTRY (MALE, FEMALE, AND NEUTRAL LANDMARKS)
// ---------------------------------------------------------------------------

const HUMAN_LANDMARKS: readonly AnatomicalLandmark[] = [
  // --- HEAD & CRANIOFACIAL ---
  {
    id: 'anat_cranium',
    name: 'Cranium / Neurocranium',
    aliases: ['skull', 'cranial vault', 'calvaria'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'cranium',
    canonicalCoordinates: {
      anterior: { left: 0.38, top: 0.01, right: 0.62, bottom: 0.14 },
      posterior: { left: 0.38, top: 0.01, right: 0.62, bottom: 0.14 },
      lateral: { left: 0.35, top: 0.01, right: 0.65, bottom: 0.14 },
    },
    depthLayer: 'deep',
    adjacentStructures: ['frontal bone', 'parietal bones', 'occipital bone', 'scalp'],
    relativePlacement: 'Superior to facial skeleton, cervical spine, and cranial base.',
    description: 'Encloses and protects the brain, including frontal, parietal, temporal, and occipital bones.',
    dimorphicFeatures: {
      female: 'Smoother contour, less pronounced supraorbital ridges, rounded frontal eminence.',
      male: 'Larger cranial mass, more prominent occipital protuberance and mastoid processes.',
    },
  },
  {
    id: 'anat_forehead_brow',
    name: 'Forehead and Supraorbital Ridges',
    aliases: ['forehead', 'brow ridge', 'supraorbital torus', 'glabella'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'face',
    canonicalCoordinates: {
      anterior: { left: 0.40, top: 0.04, right: 0.60, bottom: 0.08 },
      lateral: { left: 0.48, top: 0.04, right: 0.62, bottom: 0.08 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['hairline', 'orbits', 'glabella', 'frontalis muscle'],
    relativePlacement: 'Superior to orbits and nasion, inferior to trichion (frontal hairline).',
    description: 'Anterior vertical expanse of the frontal bone covering frontalis muscle and supratrochlear nerves.',
    dimorphicFeatures: {
      female: 'Vertical, flat or convex forehead profile; smooth transition to brow with minimal ridge prominence.',
      male: 'Sloped forehead profile; pronounced supraorbital ridges with prominent central glabella.',
    },
  },
  {
    id: 'anat_eyes_orbits',
    name: 'Orbits and Eyes',
    aliases: ['eyes', 'orbital region', 'palpebral fissure', 'eyelids'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'face',
    canonicalCoordinates: {
      anterior: { left: 0.41, top: 0.07, right: 0.59, bottom: 0.10 },
      lateral: { left: 0.50, top: 0.07, right: 0.60, bottom: 0.10 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['supraorbital ridge', 'nasion', 'zygomatic arch', 'infraorbital margin'],
    relativePlacement: 'Bilateral facial apertures seated beneath the supraorbital margin, lateral to nasal root.',
    description: 'Comprises ocular globes, pupils, irises, upper and lower eyelids, eyelashes, and palpebral fissures.',
    dimorphicFeatures: {
      female: 'Slightly higher eyebrow arch above supraorbital rim; larger relative interpalpebral aperture.',
      male: 'Eyebrows sit directly on or below supraorbital margin, straighter horizontal trajectory.',
    },
  },
  {
    id: 'anat_nose',
    name: 'External Nose',
    aliases: ['nose', 'nasus externus', 'nasal dorsum', 'nasal bridge', 'columella', 'alae nasi'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'face',
    canonicalCoordinates: {
      anterior: { left: 0.47, top: 0.07, right: 0.53, bottom: 0.12 },
      lateral: { left: 0.54, top: 0.07, right: 0.64, bottom: 0.12 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['nasion', 'rhinion', 'philtrum', 'nasolabial sulcus'],
    relativePlacement: 'Midline facial projection, between orbits superiorly and oral region inferiorly.',
    description: 'Pyramidal structure comprising nasal bones, lateral cartilages, greater alar cartilages, and septum.',
    dimorphicFeatures: {
      female: 'Narrower bridge and alar base, slightly obtuse nasolabial angle (~95-105°), concave or straight dorsum.',
      male: 'Broader bridge, acute to right nasolabial angle (~90-95°), prominent straight or convex dorsal profile.',
    },
  },
  {
    id: 'anat_mouth_lips',
    name: 'Oral Region and Lips',
    aliases: ['mouth', 'lips', 'labia oris', 'vermilion', 'philtrum', 'oral fissure'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'face',
    canonicalCoordinates: {
      anterior: { left: 0.45, top: 0.12, right: 0.55, bottom: 0.15 },
      lateral: { left: 0.50, top: 0.12, right: 0.59, bottom: 0.15 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['philtrum', 'nasolabial folds', 'mentolabial sulcus', 'mentum'],
    relativePlacement: 'Inferior to subnasale and columella, superior to mentolabial crease and chin.',
    description: 'Includes upper and lower vermilion zones, Cupid\'s bow, philtrum columns, and orbicularis oris muscle.',
    dimorphicFeatures: {
      female: 'Fuller vermilion projection, shorter philtrum length relative to lower face height.',
      male: 'Longer philtrum, flatter lip profile, presence of terminal facial hair / beard follicles.',
    },
  },
  {
    id: 'anat_chin_mandible',
    name: 'Chin and Mandible',
    aliases: ['chin', 'mentum', 'jaw', 'mandible', 'jawline', 'mental protuberance'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'face',
    canonicalCoordinates: {
      anterior: { left: 0.43, top: 0.14, right: 0.57, bottom: 0.18 },
      lateral: { left: 0.44, top: 0.14, right: 0.57, bottom: 0.18 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['mentolabial sulcus', 'angle of mandible', 'masseter muscle', 'submental region'],
    relativePlacement: 'Inferior-most boundary of facial skeleton; articulates with temporal bones at TMJ.',
    description: 'Lower jaw bone consisting of horizontal curved body and two vertical rami.',
    dimorphicFeatures: {
      female: 'Pointed, rounded, or tapered chin with obtuse gonial angle (~120-125°), softer jawline contours.',
      male: 'Squarer, broader mental protuberance with flared gonial angle (~110-115°), sharp defined angular jawline.',
    },
  },
  {
    id: 'anat_ears',
    name: 'Auricles / External Ears',
    aliases: ['ear', 'auricle', 'pinna', 'earlobes'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'head',
    subRegion: 'cranium',
    canonicalCoordinates: {
      anterior: { left: 0.36, top: 0.07, right: 0.64, bottom: 0.13 },
      posterior: { left: 0.36, top: 0.07, right: 0.64, bottom: 0.13 },
      lateral: { left: 0.40, top: 0.07, right: 0.48, bottom: 0.13 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['temporal bone', 'tragus', 'temporomandibular joint', 'mastoid process'],
    relativePlacement: 'Bilateral cranial appendages spanning vertically between eyebrow and subnasale planes.',
    description: 'Cartilaginous ear structure comprising helix, antihelix, concha, tragus, and fibro-fatty lobule.',
  },

  // --- CERVICAL / NECK ---
  {
    id: 'anat_laryngeal_prominence',
    name: "Laryngeal Prominence (Adam's Apple)",
    aliases: ["adam's apple", 'laryngeal prominence', 'thyroid cartilage notch', 'pomum Adami'],
    system: 'muscular',
    genderSpecificity: 'male',
    primaryRegion: 'cervical',
    subRegion: 'anterior_neck',
    canonicalCoordinates: {
      anterior: { left: 0.48, top: 0.18, right: 0.52, bottom: 0.21 },
      lateral: { left: 0.50, top: 0.18, right: 0.56, bottom: 0.21 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['thyroid cartilage', 'cricoid cartilage', 'hyoid bone', 'sternocleidomastoid'],
    relativePlacement: 'Midline anterior neck, inferior to hyoid bone, superior to thyroid gland and suprasternal notch.',
    description: 'Prominent anterior fusion angle of thyroid cartilage laminae, marking the laryngeal voice box.',
    dimorphicFeatures: {
      female: 'Obtuse thyroid lamina angle (~120°), yielding a smooth, unprojected anterior neck profile.',
      male: 'Acute thyroid lamina angle (~90°), creating a distinct protruding angular protrusion in the anterior neck.',
    },
  },
  {
    id: 'anat_neck_cervical',
    name: 'Cervical Region (Neck)',
    aliases: ['neck', 'cervical triangle', 'sternocleidomastoid', 'jugular notch', 'suprasternal notch'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'cervical',
    subRegion: 'neck',
    canonicalCoordinates: {
      anterior: { left: 0.42, top: 0.17, right: 0.58, bottom: 0.22 },
      posterior: { left: 0.42, top: 0.17, right: 0.58, bottom: 0.22 },
      lateral: { left: 0.44, top: 0.17, right: 0.56, bottom: 0.22 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['mandible', 'clavicles', 'sternum', 'trapezius', 'platysma'],
    relativePlacement: 'Connects the cranial base and mandible superiorly to the thoracic inlet and clavicles inferiorly.',
    description: 'Contains trachea, esophagus, cervical vertebrae C1-C7, carotid arteries, and muscular triangles.',
    dimorphicFeatures: {
      female: 'Slender cylindrical profile, longer visual proportions, softer trapezius slope.',
      male: 'Thicker muscular circumference, visible sternocleidomastoid and trapezius bulk, prominent jugular notch.',
    },
  },

  // --- THORAX & CHEST (FEMALE & MALE SPECIFIC) ---
  {
    id: 'anat_female_breasts',
    name: 'Female Mammary Glands (Breasts)',
    aliases: ['female breasts', 'breasts', 'mammary glands', 'bust', 'inframammary fold', 'cleavage'],
    system: 'integumentary',
    genderSpecificity: 'female',
    primaryRegion: 'thorax',
    subRegion: 'mammary',
    canonicalCoordinates: {
      anterior: { left: 0.35, top: 0.23, right: 0.65, bottom: 0.35 },
      lateral: { left: 0.50, top: 0.23, right: 0.68, bottom: 0.35 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['pectoralis major', 'sternum', 'inframammary fold', 'axillary tail of Spence'],
    relativePlacement: 'Spans between 2nd and 6th ribs vertically, from sternal border to midaxillary line horizontally.',
    description: 'Paired glandular and adipose hemispherical projections overlying pectoralis major and serratus anterior.',
    dimorphicFeatures: {
      female: 'Prominent glandular lobules and subcutaneous adipose tissue creating projection, inframammary fold, and intermammary cleft.',
      male: 'Flat, lean pectoral wall without glandular projection or inframammary crease under standard physiology.',
    },
  },
  {
    id: 'anat_female_areola_nipple',
    name: 'Female Areola and Nipple',
    aliases: ['female nipple', 'female areola', 'papilla mammaria', 'areolar complex'],
    system: 'integumentary',
    genderSpecificity: 'female',
    primaryRegion: 'thorax',
    subRegion: 'mammary',
    canonicalCoordinates: {
      anterior: { left: 0.38, top: 0.27, right: 0.62, bottom: 0.31 },
      lateral: { left: 0.58, top: 0.27, right: 0.66, bottom: 0.31 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['mammary gland', 'lactiferous ducts', 'Montgomery glands', 'pectoralis major'],
    relativePlacement: 'Located at the apex of the breast hemisphere, typically level with the 4th intercostal space.',
    description: 'Pigmented cutaneous disc (areola) containing sebaceous tubercles surrounding the raised conical papilla.',
    dimorphicFeatures: {
      female: 'Larger areolar diameter (~30-50 mm), erectile conical papilla with lactiferous duct orifices.',
      male: 'Smaller areolar diameter (~20-28 mm), flatter papilla positioned directly on the pectoral plane.',
    },
  },
  {
    id: 'anat_male_pectoral',
    name: 'Male Pectoral Region (Chest)',
    aliases: ['male chest', 'pecs', 'pectoralis major', 'male pectorals'],
    system: 'muscular',
    genderSpecificity: 'male',
    primaryRegion: 'thorax',
    subRegion: 'pectoral',
    canonicalCoordinates: {
      anterior: { left: 0.34, top: 0.22, right: 0.66, bottom: 0.33 },
      lateral: { left: 0.48, top: 0.22, right: 0.62, bottom: 0.33 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['clavicles', 'sternum', 'deltoid', 'rectus abdominis', 'serratus anterior'],
    relativePlacement: 'Spans from medial clavicle and sternum laterally to the humerus intertubercular groove.',
    description: 'Thick muscular chest wall comprising clavicular, sternocostal, and abdominal heads of pectoralis major.',
    dimorphicFeatures: {
      female: 'Underlies mammary glands; muscle boundary obscured by breast adipose and glandular tissue.',
      male: 'Directly visible muscular contours with defined sternal margin, inferior pectoral line, and anterior axillary fold.',
    },
  },
  {
    id: 'anat_male_nipple',
    name: 'Male Areola and Nipple',
    aliases: ['male nipple', 'male areola', 'pectoral nipple'],
    system: 'integumentary',
    genderSpecificity: 'male',
    primaryRegion: 'thorax',
    subRegion: 'pectoral',
    canonicalCoordinates: {
      anterior: { left: 0.39, top: 0.27, right: 0.61, bottom: 0.30 },
      lateral: { left: 0.52, top: 0.27, right: 0.58, bottom: 0.30 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['pectoralis major', '4th intercostal space', 'anterior axillary line'],
    relativePlacement: 'Overlies the 4th intercostal space, approximately 10-12 cm from the sternal midline.',
    description: 'Flat or subtly raised pigmented circular zone situated directly over the lower lateral pectoralis major.',
  },
  {
    id: 'anat_sternum_ribs',
    name: 'Sternum and Thoracic Cage',
    aliases: ['sternum', 'breastbone', 'rib cage', 'costal margin', 'xiphoid process', 'angle of Louis'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'thorax',
    subRegion: 'thoracic_skeleton',
    canonicalCoordinates: {
      anterior: { left: 0.36, top: 0.21, right: 0.64, bottom: 0.37 },
      posterior: { left: 0.36, top: 0.21, right: 0.64, bottom: 0.37 },
      lateral: { left: 0.40, top: 0.21, right: 0.60, bottom: 0.37 },
    },
    depthLayer: 'deep',
    adjacentStructures: ['clavicles', 'costal cartilages', 'thoracic vertebrae T1-T12', 'intercostal muscles'],
    relativePlacement: 'Central osteocartilaginous framework enclosing heart, lungs, and mediastinal structures.',
    description: 'Composed of manubrium, body of sternum, xiphoid process, and 12 pairs of articulating ribs.',
    dimorphicFeatures: {
      female: 'Shorter sternal body, wider subcostal angle (>75°), narrower rib cage diameter relative to pelvis.',
      male: 'Longer sternal body (more than twice manubrium length), narrower subcostal angle (~70°), broad barrel thorax.',
    },
  },

  // --- ABDOMEN ---
  {
    id: 'anat_abdomen_rectus',
    name: 'Abdominal Wall and Rectus Abdominis',
    aliases: ['abdomen', 'belly', 'stomach', 'abs', 'rectus abdominis', 'linea alba', 'flanks'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'abdomen',
    subRegion: 'anterior_abdominal_wall',
    canonicalCoordinates: {
      anterior: { left: 0.38, top: 0.33, right: 0.62, bottom: 0.48 },
      lateral: { left: 0.45, top: 0.33, right: 0.58, bottom: 0.48 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['costal margin', 'umbilicus', 'linea alba', 'inguinal ligament', 'iliac crest'],
    relativePlacement: 'Extends from xiphoid process and costal margins superiorly to pubic crest and inguinal ligaments inferiorly.',
    description: 'Layered musculature comprising rectus abdominis, external obliques, internal obliques, and transversus abdominis.',
    dimorphicFeatures: {
      female: 'Subcutaneous fat layer creates smoother, softer anterior curve; waist indentation sits higher, above umbilicus.',
      male: 'Lower subcutaneous fat ratio, prominent tendinous intersections ("six pack"), waist indentation sits lower near iliac crest.',
    },
  },
  {
    id: 'anat_umbilicus',
    name: 'Umbilicus (Navel / Belly Button)',
    aliases: ['navel', 'umbilicus', 'belly button'],
    system: 'surface-anatomy',
    genderSpecificity: 'neutral',
    primaryRegion: 'abdomen',
    subRegion: 'umbilical_region',
    canonicalCoordinates: {
      anterior: { left: 0.48, top: 0.40, right: 0.52, bottom: 0.42 },
      lateral: { left: 0.54, top: 0.40, right: 0.58, bottom: 0.42 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['linea alba', 'rectus abdominis', 'umbilical ring'],
    relativePlacement: 'Midline fibrous scar on anterior abdominal wall at approximately L3-L4 vertebral level.',
    description: 'Depressed cutaneous cicatrix marking the fetal umbilical cord attachment point.',
  },

  // --- PELVIC & PERINEAL (FEMALE & MALE SPECIFIC) ---
  {
    id: 'anat_female_pelvis_hips',
    name: 'Female Pelvis and Hip Framework',
    aliases: ['female pelvis', 'female hips', 'gynecoid pelvis', 'iliac crests', 'hip breadth'],
    system: 'skeletal',
    genderSpecificity: 'female',
    primaryRegion: 'pelvis',
    subRegion: 'pelvic_girdle',
    canonicalCoordinates: {
      anterior: { left: 0.32, top: 0.45, right: 0.68, bottom: 0.56 },
      posterior: { left: 0.32, top: 0.45, right: 0.68, bottom: 0.56 },
      lateral: { left: 0.40, top: 0.45, right: 0.60, bottom: 0.56 },
    },
    depthLayer: 'deep',
    adjacentStructures: ['sacrum', 'coccyx', 'femoral heads', 'inguinal ligament', 'greater trochanters'],
    relativePlacement: 'Connects the lumbar spine to lower extremities; wider lateral flare than thorax.',
    description: 'Gynecoid pelvic structure with wide pelvic inlet, shallow basin, flared ilium, and broad pubic arch (>85°).',
    dimorphicFeatures: {
      female: 'Distinctly broader bitrochanteric width exceeding shoulder width; waist-to-hip ratio typically ~0.7.',
      male: 'Narrower, upright android pelvis with heart-shaped inlet and acute pubic arch (<70°); waist-to-hip ratio ~0.85-0.95.',
    },
  },
  {
    id: 'anat_female_external_genitalia',
    name: 'Female External Genitalia (Vulva & Perineum)',
    aliases: ['vulva', 'mons pubis', 'labia majora', 'labia minora', 'clitoris', 'perineum', 'female pudendum'],
    system: 'urogenital',
    genderSpecificity: 'female',
    primaryRegion: 'pelvis',
    subRegion: 'perineum',
    canonicalCoordinates: {
      anterior: { left: 0.46, top: 0.49, right: 0.54, bottom: 0.55 },
      lateral: { left: 0.48, top: 0.49, right: 0.54, bottom: 0.55 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['mons pubis', 'pubic symphysis', 'perineal body', 'ischial tuberosities', 'anus'],
    relativePlacement: 'Inferior to mons pubis and pubic symphysis, anterior to anal orifice between medial upper thighs.',
    description: 'Includes mons pubis, labia majora, labia minora, clitoral hood, glans clitoris, vaginal vestibule, and urethral orifice.',
    dimorphicFeatures: {
      female: 'Vestibular cleft flanked by labia; internal reproductive canal connection; no external pendular structures.',
      male: 'External pendular penis and scrotal sac suspended anterior to perineum.',
    },
  },
  {
    id: 'anat_male_pelvis_hips',
    name: 'Male Pelvis and Hip Framework',
    aliases: ['male pelvis', 'male hips', 'android pelvis'],
    system: 'skeletal',
    genderSpecificity: 'male',
    primaryRegion: 'pelvis',
    subRegion: 'pelvic_girdle',
    canonicalCoordinates: {
      anterior: { left: 0.35, top: 0.45, right: 0.65, bottom: 0.55 },
      posterior: { left: 0.35, top: 0.45, right: 0.65, bottom: 0.55 },
      lateral: { left: 0.42, top: 0.45, right: 0.58, bottom: 0.55 },
    },
    depthLayer: 'deep',
    adjacentStructures: ['sacrum', 'femoral heads', 'acetabulum', 'pubic symphysis'],
    relativePlacement: 'Connects lumbar spine to lower extremities; width is narrower than biacromial shoulder width.',
    description: 'Heavy, robust android pelvic architecture with narrow pelvic outlet, steep vertical iliac blades, and acute subpubic angle.',
  },
  {
    id: 'anat_male_external_genitalia',
    name: 'Male External Genitalia (Penis & Scrotum)',
    aliases: ['penis', 'scrotum', 'male genitalia', 'testes', 'glans penis', 'perineal raphe'],
    system: 'urogenital',
    genderSpecificity: 'male',
    primaryRegion: 'pelvis',
    subRegion: 'perineum',
    canonicalCoordinates: {
      anterior: { left: 0.46, top: 0.49, right: 0.54, bottom: 0.56 },
      lateral: { left: 0.50, top: 0.49, right: 0.56, bottom: 0.56 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['pubic symphysis', 'spermatic cord', 'perineal raphe', 'testes', 'inguinal canal', 'scrotum'],
    relativePlacement: 'Suspended externally from the subpubic anterior perineum between the medial proximal thighs.',
    description: 'Composed of penis (shaft, paired corpora cavernosa, corpus spongiosum, glans) and cutaneous scrotal sac housing testes.',
  },

  // --- DORSAL / BACK & GLUTEAL ---
  {
    id: 'anat_dorsal_spine_scapula',
    name: 'Back, Spine, and Scapular Region',
    aliases: ['back', 'spine', 'vertebral column', 'shoulder blades', 'scapulae', 'latissimus dorsi', 'trapezius'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'dorsal',
    subRegion: 'upper_lower_back',
    canonicalCoordinates: {
      posterior: { left: 0.32, top: 0.18, right: 0.68, bottom: 0.47 },
      lateral: { left: 0.38, top: 0.18, right: 0.50, bottom: 0.47 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['cervical spine', 'rib cage', 'scapular spine', 'erector spinae', 'sacrum'],
    relativePlacement: 'Posterior trunk from base of skull and cervical vertebra C7 down to sacral base.',
    description: 'Includes spine curves (thoracic kyphosis, lumbar lordosis), scapulae, trapezius, latissimus dorsi, and erector spinae.',
    dimorphicFeatures: {
      female: 'Slightly greater lumbar lordosis angle, narrower biacromial shoulder width, smooth contour.',
      male: 'Broad biacromial width creating V-taper with latissimus dorsi, distinct muscular definition around scapulae.',
    },
  },
  {
    id: 'anat_gluteal_region',
    name: 'Gluteal Region (Buttocks)',
    aliases: ['buttocks', 'gluteus maximus', 'gluteal fold', 'natal cleft', 'glutes'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'dorsal',
    subRegion: 'buttocks',
    canonicalCoordinates: {
      posterior: { left: 0.34, top: 0.47, right: 0.66, bottom: 0.58 },
      lateral: { left: 0.36, top: 0.47, right: 0.52, bottom: 0.58 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['sacrum', 'coccyx', 'greater trochanter', 'infragluteal fold', 'hamstrings'],
    relativePlacement: 'Posterior to the pelvis, between the iliac crest superiorly and the gluteal fold inferiorly.',
    description: 'Muscular and adipose mass formed predominantly by gluteus maximus, gluteus medius, and overlying adipose layer.',
    dimorphicFeatures: {
      female: 'Pronounced gynoid adipose distribution providing rounded, fuller lateral and posterior projection; wider pelvic base.',
      male: 'Tighter muscular android contour, less subcutaneous adipose, flatter posterior profile.',
    },
  },

  // --- UPPER EXTREMITIES ---
  {
    id: 'anat_shoulder_deltoid',
    name: 'Shoulder and Deltoid',
    aliases: ['shoulder', 'deltoid', 'acromion', 'clavicle', 'glenohumeral joint'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'upper_extremity',
    subRegion: 'shoulder',
    canonicalCoordinates: {
      anterior: { left: 0.26, top: 0.20, right: 0.74, bottom: 0.28 },
      posterior: { left: 0.26, top: 0.20, right: 0.74, bottom: 0.28 },
      lateral: { left: 0.42, top: 0.20, right: 0.58, bottom: 0.28 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['clavicle', 'acromion process', 'rotator cuff', 'brachium'],
    relativePlacement: 'Junction of pectoral girdle and arm; lateral to cervical base and superior thorax.',
    description: 'Forms rounded muscular contour of shoulder covering glenohumeral joint; anterior, lateral, posterior heads.',
    dimorphicFeatures: {
      female: 'Narrower biacromial span, gentler slope from neck, less muscular bulk.',
      male: 'Broad biacromial span, pronounced deltoid mass creating wide upper torso silhouette.',
    },
  },
  {
    id: 'anat_arm_brachium',
    name: 'Arm (Brachium - Biceps and Triceps)',
    aliases: ['arm', 'upper arm', 'brachium', 'biceps', 'triceps'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'upper_extremity',
    subRegion: 'arm',
    canonicalCoordinates: {
      anterior: { left: 0.23, top: 0.26, right: 0.77, bottom: 0.38 },
      posterior: { left: 0.23, top: 0.26, right: 0.77, bottom: 0.38 },
      lateral: { left: 0.44, top: 0.26, right: 0.56, bottom: 0.38 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['humerus', 'biceps brachii', 'triceps brachii', 'brachialis'],
    relativePlacement: 'Between the glenohumeral shoulder joint superiorly and cubital elbow joint inferiorly.',
    description: 'Humerus surrounded by anterior flexor compartment (biceps, brachialis) and posterior extensor compartment (triceps).',
  },
  {
    id: 'anat_elbow_cubital',
    name: 'Elbow and Cubital Fossa',
    aliases: ['elbow', 'cubital fossa', 'olecranon', 'medial epicondyle'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'upper_extremity',
    subRegion: 'elbow',
    canonicalCoordinates: {
      anterior: { left: 0.22, top: 0.36, right: 0.78, bottom: 0.42 },
      posterior: { left: 0.22, top: 0.36, right: 0.78, bottom: 0.42 },
      lateral: { left: 0.45, top: 0.36, right: 0.55, bottom: 0.42 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['humerus epicondyles', 'olecranon process', 'radius head', 'bicipital aponeurosis'],
    relativePlacement: 'Hinge joint linking the brachium and antebrachium.',
    description: 'Comprises humeroulnar, humeroradial, and proximal radioulnar joints; posterior olecranon prominence.',
  },
  {
    id: 'anat_forearm_antebrachium',
    name: 'Forearm (Antebrachium)',
    aliases: ['forearm', 'antebrachium', 'radius', 'ulna'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'upper_extremity',
    subRegion: 'forearm',
    canonicalCoordinates: {
      anterior: { left: 0.20, top: 0.39, right: 0.80, bottom: 0.51 },
      posterior: { left: 0.20, top: 0.39, right: 0.80, bottom: 0.51 },
      lateral: { left: 0.44, top: 0.39, right: 0.56, bottom: 0.51 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['radius', 'ulna', 'flexor digitorum', 'extensor digitorum', 'brachioradialis'],
    relativePlacement: 'Between the cubital joint proximally and carpal wrist joint distally.',
    description: 'Houses radius and ulna, permitting pronation/supination, with anterior flexor and posterior extensor compartments.',
  },
  {
    id: 'anat_wrist_hand_digits',
    name: 'Wrist, Hand, and Fingers (Manus)',
    aliases: ['hand', 'wrist', 'fingers', 'carpus', 'manus', 'palm', 'thumb', 'digits'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'upper_extremity',
    subRegion: 'hand',
    canonicalCoordinates: {
      anterior: { left: 0.17, top: 0.49, right: 0.83, bottom: 0.60 },
      posterior: { left: 0.17, top: 0.49, right: 0.83, bottom: 0.60 },
      lateral: { left: 0.45, top: 0.49, right: 0.55, bottom: 0.60 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['carpal bones', 'metacarpals', 'phalanges', 'thenar eminence', 'hypothenar eminence'],
    relativePlacement: 'Distal terminus of upper extremity.',
    description: 'Composed of 8 carpal bones, 5 metacarpals, 14 phalanges (pollex + 4 triphalangeal fingers), palmar and dorsal aspects.',
    dimorphicFeatures: {
      female: 'Slender fingers, smaller palm breadth, higher 2D:4D digit ratio (index often equal to or longer than ring finger).',
      male: 'Broader palm, thicker digits, lower 2D:4D digit ratio (ring finger often longer than index finger).',
    },
  },

  // --- LOWER EXTREMITIES ---
  {
    id: 'anat_thigh_femoral',
    name: 'Thigh (Femoral Region)',
    aliases: ['thigh', 'quadriceps', 'hamstrings', 'femur', 'adductors'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'lower_extremity',
    subRegion: 'thigh',
    canonicalCoordinates: {
      anterior: { left: 0.33, top: 0.54, right: 0.67, bottom: 0.72 },
      posterior: { left: 0.33, top: 0.54, right: 0.67, bottom: 0.72 },
      lateral: { left: 0.40, top: 0.54, right: 0.60, bottom: 0.72 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['femur', 'quadriceps femoris', 'hamstrings', 'iliotibial tract', 'femoral triangle'],
    relativePlacement: 'Between hip joint / gluteal fold proximally and knee joint distally.',
    description: 'Longest segment of lower limb; anterior quadriceps, posterior hamstrings, medial adductors around the femur.',
    dimorphicFeatures: {
      female: 'Greater quadriceps angle (Q-angle ~17°) due to wider pelvis; higher subcutaneous fat distribution.',
      male: 'Smaller Q-angle (~12°), visible quadriceps muscular separation (rectus femoris, vastus lateralis/medialis).',
    },
  },
  {
    id: 'anat_knee_patella',
    name: 'Knee and Patella',
    aliases: ['knee', 'patella', 'kneecap', 'popliteal fossa'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'lower_extremity',
    subRegion: 'knee',
    canonicalCoordinates: {
      anterior: { left: 0.36, top: 0.70, right: 0.64, bottom: 0.77 },
      posterior: { left: 0.36, top: 0.70, right: 0.64, bottom: 0.77 },
      lateral: { left: 0.44, top: 0.70, right: 0.56, bottom: 0.77 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['femoral condyles', 'tibial plateau', 'patellar ligament', 'popliteal fossa'],
    relativePlacement: 'Intermediate articulation connecting thigh and crus.',
    description: 'Bicondylar hinge joint capped anteriorly by sesamoid patella; houses menisci and cruciate ligaments.',
  },
  {
    id: 'anat_leg_calf_tibia',
    name: 'Lower Leg and Calf (Crus)',
    aliases: ['calf', 'shin', 'tibia', 'fibula', 'gastrocnemius', 'soleus', 'achilles tendon'],
    system: 'muscular',
    genderSpecificity: 'neutral',
    primaryRegion: 'lower_extremity',
    subRegion: 'lower_leg',
    canonicalCoordinates: {
      anterior: { left: 0.36, top: 0.76, right: 0.64, bottom: 0.90 },
      posterior: { left: 0.36, top: 0.76, right: 0.64, bottom: 0.90 },
      lateral: { left: 0.43, top: 0.76, right: 0.57, bottom: 0.90 },
    },
    depthLayer: 'intermediate',
    adjacentStructures: ['tibia', 'fibula', 'gastrocnemius', 'soleus', 'Achilles tendon'],
    relativePlacement: 'Between knee joint proximally and ankle joint distally.',
    description: 'Anterior subcutaneous tibial crest (shin) and posterior muscular calf bulges (gastrocnemius heads, soleus).',
  },
  {
    id: 'anat_ankle_foot_digits',
    name: 'Ankle, Foot, and Toes (Pes)',
    aliases: ['foot', 'ankle', 'toes', 'malleolus', 'heel', 'calcaneus', 'plantar arch', 'pes'],
    system: 'skeletal',
    genderSpecificity: 'neutral',
    primaryRegion: 'lower_extremity',
    subRegion: 'foot',
    canonicalCoordinates: {
      anterior: { left: 0.34, top: 0.89, right: 0.66, bottom: 0.99 },
      posterior: { left: 0.34, top: 0.89, right: 0.66, bottom: 0.99 },
      lateral: { left: 0.40, top: 0.89, right: 0.62, bottom: 0.99 },
    },
    depthLayer: 'superficial',
    adjacentStructures: ['medial malleolus', 'lateral malleolus', 'calcaneus', 'metatarsals', 'phalanges'],
    relativePlacement: 'Distal weight-bearing platform of lower extremity.',
    description: 'Includes talocrural ankle joint, tarsal bones, heel (calcaneus), longitudinal arches, 5 metatarsals, and 14 phalangeal toes.',
  },
];

// ---------------------------------------------------------------------------
// COMPARATIVE ANIMAL ANATOMY REGISTRY
// ---------------------------------------------------------------------------

const ANIMAL_LANDMARKS: readonly AnimalAnatomyLandmark[] = [
  // --- QUADRUPED CANINE / FELINE / EQUINE ---
  {
    id: 'animal_rostrum_muzzle',
    taxon: 'general_quadruped',
    name: 'Muzzle / Rostrum',
    aliases: ['muzzle', 'snout', 'rostrum', 'whiskers', 'rhinarium'],
    bodyPlan: 'quadruped',
    region: 'cranial',
    canonicalCoordinates: { left: 0.65, top: 0.15, right: 0.85, bottom: 0.30 },
    relativePlacement: 'Anterior-most facial projection of the skull containing nasal cavities, jowls, and teeth.',
    homologueToHuman: 'Homologous to human external nose, maxilla, and premaxilla.',
    description: 'Elongated cranial region adapted for olfaction, prey capture, and mastication in quadrupeds.',
  },
  {
    id: 'animal_withers',
    taxon: 'general_quadruped',
    name: 'Withers',
    aliases: ['withers', 'dorsal shoulder ridge'],
    bodyPlan: 'quadruped',
    region: 'thoracic_dorsal',
    canonicalCoordinates: { left: 0.45, top: 0.20, right: 0.58, bottom: 0.32 },
    relativePlacement: 'Highest dorsal point of the back at the base of the neck, formed by dorsal spinous processes of T2-T6 vertebrae.',
    homologueToHuman: 'Corresponds to upper thoracic vertebral spines (T1-T5) and superior scapular borders.',
    description: 'Standard height reference point for quadrupeds; serves as muscular anchor for neck and shoulder girdle.',
  },
  {
    id: 'animal_forelimb_elbow',
    taxon: 'general_quadruped',
    name: 'Forelimb Elbow (Olecranon)',
    aliases: ['elbow', 'forelimb olecranon'],
    bodyPlan: 'quadruped',
    region: 'forelimb',
    canonicalCoordinates: { left: 0.48, top: 0.45, right: 0.58, bottom: 0.55 },
    relativePlacement: 'Located high on the lateral chest wall, caudal to shoulder and proximal to forelimb carpus.',
    homologueToHuman: 'Exact homologue to human olecranon process and elbow joint.',
    description: 'Hinge articulation between humerus and radius/ulna; flexes caudally.',
  },
  {
    id: 'animal_forelimb_carpus',
    taxon: 'general_quadruped',
    name: 'Carpus (Forelimb "Knee" in Ungulates)',
    aliases: ['carpus', 'knee of horse', 'wrist of dog', 'forepaw wrist'],
    bodyPlan: 'quadruped',
    region: 'forelimb',
    canonicalCoordinates: { left: 0.50, top: 0.60, right: 0.60, bottom: 0.70 },
    relativePlacement: 'Between radius/ulna proximally and metacarpus/cannon bone distally.',
    homologueToHuman: 'Homologous to the human wrist and carpal bones (NOT the human knee).',
    description: 'Complex joint composed of carpal bones; often colloquially misnamed "knee" in horses and cows.',
  },
  {
    id: 'animal_hindlimb_stifle',
    taxon: 'general_quadruped',
    name: 'Stifle Joint (True Knee)',
    aliases: ['stifle', 'stifle joint', 'patellar joint'],
    bodyPlan: 'quadruped',
    region: 'hindlimb',
    canonicalCoordinates: { left: 0.25, top: 0.45, right: 0.38, bottom: 0.58 },
    relativePlacement: 'Between femur and tibia on hindlimb, cranial to the lower flank.',
    homologueToHuman: 'Exact homologue to human knee joint, including patella, menisci, and cruciate ligaments.',
    description: 'True anatomical knee of quadrupeds; flexes cranially, positioned close to body flank.',
  },
  {
    id: 'animal_hindlimb_hock',
    taxon: 'general_quadruped',
    name: 'Hock (Tarsus / Calcaneus)',
    aliases: ['hock', 'tarsus', 'hock joint', 'calcaneus point'],
    bodyPlan: 'quadruped',
    region: 'hindlimb',
    canonicalCoordinates: { left: 0.18, top: 0.60, right: 0.28, bottom: 0.72 },
    relativePlacement: 'Prominent caudal angle of hindlimb, between tibia proximally and metatarsus distally.',
    homologueToHuman: 'Homologous to human ankle and heel bone (calcaneus), elevated off the ground in digitigrade/unguligrade animals.',
    description: 'Prominent backward-pointing joint equivalent to human heel; connected to gastrocnemius via Achilles tendon.',
  },
  {
    id: 'animal_caudal_tail',
    taxon: 'general_quadruped',
    name: 'Caudal Tail and Vertebrae',
    aliases: ['tail', 'caudal vertebrae', 'dock'],
    bodyPlan: 'quadruped',
    region: 'caudal_tail',
    canonicalCoordinates: { left: 0.05, top: 0.30, right: 0.20, bottom: 0.65 },
    relativePlacement: 'Extends caudally from the sacrum and pelvic rump.',
    homologueToHuman: 'Homologous to human coccyx (tailbone), which is fused and vestigial in humans.',
    description: 'Composed of 5-25 mobile caudal vertebrae; provides balance, communication, and locomotion steering.',
  },

  // --- AVIAN BODY PLAN ---
  {
    id: 'animal_avian_beak',
    taxon: 'avian',
    name: 'Beak / Rhamphotheca',
    aliases: ['beak', 'bill', 'culmen', 'mandibles'],
    bodyPlan: 'biped_avian',
    region: 'cranial',
    canonicalCoordinates: { left: 0.65, top: 0.10, right: 0.85, bottom: 0.25 },
    relativePlacement: 'Anterior cranial projection comprising keratinous rhamphotheca over bony maxilla and mandible.',
    homologueToHuman: 'Homologous to human premaxilla, maxilla, and mandible covered in specialized keratin.',
    description: 'Toothless lightweight keratinous structure adapted for feeding, grooming, and defense.',
  },
  {
    id: 'animal_avian_wing',
    taxon: 'avian',
    name: 'Avian Wing Framework',
    aliases: ['wing', 'flight feathers', 'primaries', 'secondaries', 'humerus', 'carpometacarpus'],
    bodyPlan: 'biped_avian',
    region: 'forelimb',
    canonicalCoordinates: { left: 0.30, top: 0.25, right: 0.70, bottom: 0.60 },
    relativePlacement: 'Modified forelimb attached to pectoral girdle and keel/sternum.',
    homologueToHuman: 'Exact homologue to human arm, forearm, wrist, and fused digits (humerus, radius/ulna, carpometacarpus).',
    description: 'Aerodynamic airfoil structure bearing primary and secondary remiges (flight feathers).',
  },
];

// ---------------------------------------------------------------------------
// OBJECTS, PLACES, AND SPATIAL ENTITIES REGISTRY
// ---------------------------------------------------------------------------

const OBJECT_PLACE_ENTITIES: readonly ObjectPlaceEntity[] = [
  // --- OBJECTS ---
  {
    id: 'obj_vehicle_car',
    category: 'object',
    name: 'Automobile / Vehicle',
    aliases: ['car', 'automobile', 'vehicle', 'auto', 'sedan', 'truck'],
    subCategory: 'transportation',
    keyComponents: ['chassis', 'windshield', 'hood/bonnet', 'cabin', 'wheels/tires', 'headlights', 'doors', 'trunk'],
    spatialStructure: 'Ground-plane anchored 3D volume with longitudinal symmetry, 4 ground contact points, transparent glass canopy.',
    visualProperties: ['specular metallic reflection', 'fresnel glass transparency', 'matte rubber tires', 'perspective vanishing lines'],
  },
  {
    id: 'obj_hand_tool',
    category: 'object',
    name: 'Hand Tool (Hammer / Wrench / Knife)',
    aliases: ['tool', 'hammer', 'wrench', 'knife', 'hand tool', 'screwdriver'],
    subCategory: 'tools',
    keyComponents: ['handle/grip', 'shaft/shank', 'functional head/blade/jaw', 'fulcrum/pivot'],
    spatialStructure: 'Linear or angled ergonomic object scaled to human grip span (10-35 cm), clear functional orientation.',
    visualProperties: ['tactile textured grip', 'machined metallic edge/face', 'wear/abrasion highlights'],
  },
  {
    id: 'obj_electronic_device',
    category: 'object',
    name: 'Digital Device (Display / Phone / Computer)',
    aliases: ['device', 'phone', 'computer', 'screen', 'laptop', 'display', 'tablet'],
    subCategory: 'electronics',
    keyComponents: ['screen/display panel', 'bezel', 'housing/chassis', 'optical sensors/camera', 'interface ports'],
    spatialStructure: 'Planar rectangular geometric prism with high aspect ratio display surface and rounded corner fillets.',
    visualProperties: ['emissive active display pixels', 'oleophobic glass sheen', 'anodized aluminum or matte polymer chassis'],
  },
  {
    id: 'obj_furniture',
    category: 'object',
    name: 'Furniture (Chair / Desk / Sofa)',
    aliases: ['furniture', 'chair', 'desk', 'sofa', 'table', 'couch'],
    subCategory: 'interior_furnishing',
    keyComponents: ['load-bearing legs/base', 'seating plane / tabletop', 'backrest/support', 'armrests'],
    spatialStructure: 'Orthogonal or ergonomic load-bearing spatial assembly positioned on floor plane at human working height.',
    visualProperties: ['upholstery fabric/leather texture', 'grain wood or tubular metal', 'cast contact shadows on floor'],
  },

  // --- PLACES ---
  {
    id: 'place_interior_room',
    category: 'place',
    name: 'Interior Architectural Space',
    aliases: ['room', 'interior', 'indoor', 'office', 'living room', 'studio', 'chamber'],
    subCategory: 'indoor_environment',
    keyComponents: ['floor plane', 'vertical wall boundaries', 'ceiling plane', 'apertures (windows/doors)', 'ambient/point light fixtures'],
    spatialStructure: 'Enclosed 3D volumetric room with defined 1-point or 2-point perspective vanishing points, occluding corners.',
    visualProperties: ['indirect diffuse bounced light', 'contact wall-floor ambient occlusion', 'linear architectural perspective'],
  },
  {
    id: 'place_outdoor_natural',
    category: 'place',
    name: 'Natural Landscape (Mountains / Forest / Coast)',
    aliases: ['mountains', 'mountain', 'forest', 'coast', 'landscape', 'nature', 'outdoors', 'beach'],
    subCategory: 'outdoor_nature',
    keyComponents: ['terrain ground plane', 'horizon boundary', 'vegetation canopy', 'sky/atmosphere dome', 'water bodies'],
    spatialStructure: 'Continuous non-planar organic depth gradient spanning foreground (0-10m), midground (10-500m), background (>500m).',
    visualProperties: ['atmospheric haze / aerial perspective Rayleigh scattering', 'sun directional cast shadows', 'fractal terrain detail'],
  },
  {
    id: 'place_urban_cityscape',
    category: 'place',
    name: 'Urban Street and Cityscape',
    aliases: ['city', 'street', 'cityscape', 'urban', 'plaza', 'road'],
    subCategory: 'built_outdoor',
    keyComponents: ['roadway/pavement', 'sidewalk curb', 'building facades', 'street furniture', 'skyline vanishing perspective'],
    spatialStructure: 'Urban corridor flanked by tall vertical building envelopes, deep perspective corridor leading to horizon.',
    visualProperties: ['asphalt specular sheen under rain', 'multi-point artificial and natural illumination', 'receding depth scale'],
  },

  // --- THINGS / MATERIALS ---
  {
    id: 'thing_human_skin',
    category: 'thing',
    name: 'Human Skin (Epidermis / Dermis)',
    aliases: ['skin', 'epidermis', 'flesh', 'human skin'],
    subCategory: 'organic_tissue',
    keyComponents: ['stratum corneum', 'melanin pigmentation', 'subsurface capillary bed', 'pores/dermatoglyphics'],
    spatialStructure: 'Continuous conformable envelope wrapping skeletal and muscular anatomical volumes.',
    visualProperties: ['subsurface scattering (SSS) with warm reddish transmittance', 'micro-roughness specular highlights', 'fine pore texture'],
  },
  {
    id: 'thing_fabrics_textiles',
    category: 'thing',
    name: 'Fabrics and Clothing Textiles',
    aliases: ['fabrics', 'fabric', 'textiles', 'textile', 'clothing', 'cloth'],
    subCategory: 'material',
    keyComponents: ['woven yarn matrix', 'folds/creases', 'drape contours', 'seams/hems'],
    spatialStructure: 'Thin pliable surface sheet conforming to underlying human anatomy with gravity-dependent tension and draping folds.',
    visualProperties: ['sheen/fresnel grazing reflection (velvet/silk)', 'matte weave roughness (denim/cotton)', 'wrinkle shadow micro-geometry'],
  },
];

// ---------------------------------------------------------------------------
// PUBLIC API & LOOKUP FUNCTIONS
// ---------------------------------------------------------------------------

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchesWordOrSubstring(text: string, query: string): boolean {
  const norm = normalizeQuery(text);
  if (query.length < 5) {
    const words = norm.split(/\s+/);
    return words.includes(query);
  }
  return norm.includes(query) || query.includes(norm);
}

/**
 * Searches the anatomical registry for a human anatomical landmark by name, alias, or keyword.
 */
export function lookupAnatomicalLandmark(query: string, gender?: AnatomicalGender): AnatomicalQueryResult {
  const normalized = normalizeQuery(query);
  if (!normalized) return { found: false, query };

  // 1. Exact id or name match
  for (const landmark of HUMAN_LANDMARKS) {
    if (gender && landmark.genderSpecificity !== 'neutral' && landmark.genderSpecificity !== gender) {
      continue;
    }
    if (normalizeQuery(landmark.id) === normalized || normalizeQuery(landmark.name) === normalized) {
      return { found: true, landmark, matchedBy: 'exact', query };
    }
  }

  // 2. Exact alias match
  for (const landmark of HUMAN_LANDMARKS) {
    if (gender && landmark.genderSpecificity !== 'neutral' && landmark.genderSpecificity !== gender) {
      continue;
    }
    for (const alias of landmark.aliases) {
      if (normalizeQuery(alias) === normalized) {
        return { found: true, landmark, matchedBy: 'alias', query };
      }
    }
  }

  // 3. Substring / fuzzy match
  for (const landmark of HUMAN_LANDMARKS) {
    if (gender && landmark.genderSpecificity !== 'neutral' && landmark.genderSpecificity !== gender) {
      continue;
    }
    if (matchesWordOrSubstring(landmark.name, normalized)) {
      return { found: true, landmark, matchedBy: 'fuzzy', query };
    }
    for (const alias of landmark.aliases) {
      if (matchesWordOrSubstring(alias, normalized)) {
        return { found: true, landmark, matchedBy: 'fuzzy', query };
      }
    }
  }

  return { found: false, query };
}

/**
 * Searches the comparative animal anatomy registry.
 */
export function lookupAnimalLandmark(query: string, taxon?: AnimalTaxon): AnatomicalQueryResult {
  const normalized = normalizeQuery(query);
  if (!normalized) return { found: false, query };

  for (const landmark of ANIMAL_LANDMARKS) {
    if (taxon && landmark.taxon !== 'general_quadruped' && landmark.taxon !== taxon) {
      continue;
    }
    if (normalizeQuery(landmark.id) === normalized || normalizeQuery(landmark.name) === normalized) {
      return { found: true, comparativeAnimal: landmark, matchedBy: 'exact', query };
    }
    for (const alias of landmark.aliases) {
      if (normalizeQuery(alias) === normalized) {
        return { found: true, comparativeAnimal: landmark, matchedBy: 'alias', query };
      }
    }
    if (matchesWordOrSubstring(landmark.name, normalized)) {
      return { found: true, comparativeAnimal: landmark, matchedBy: 'fuzzy', query };
    }
    for (const alias of landmark.aliases) {
      if (matchesWordOrSubstring(alias, normalized)) {
        return { found: true, comparativeAnimal: landmark, matchedBy: 'fuzzy', query };
      }
    }
  }

  return { found: false, query };
}

/**
 * Lists all registered human anatomical landmarks, optionally filtered by region, system, or gender.
 */
export function listAnatomicalLandmarks(options?: {
  region?: AnatomicalLandmark['primaryRegion'];
  system?: BodySystem;
  gender?: AnatomicalGender;
}): readonly AnatomicalLandmark[] {
  return HUMAN_LANDMARKS.filter((landmark) => {
    if (options?.region && landmark.primaryRegion !== options.region) return false;
    if (options?.system && landmark.system !== options.system) return false;
    if (options?.gender && landmark.genderSpecificity !== 'neutral' && landmark.genderSpecificity !== options.gender) {
      return false;
    }
    return true;
  });
}

/**
 * Returns comparative animal anatomical landmarks for a specific animal taxon or body plan.
 */
export function listAnimalLandmarks(taxon?: AnimalTaxon): readonly AnimalAnatomyLandmark[] {
  if (!taxon) return ANIMAL_LANDMARKS;
  return ANIMAL_LANDMARKS.filter((item) => item.taxon === taxon || item.taxon === 'general_quadruped');
}

/**
 * Looks up object, place, or thing definitions by name or subcategory.
 */
export function lookupSpatialEntity(query: string): ObjectPlaceEntity | undefined {
  const normalized = normalizeQuery(query);
  if (!normalized) return undefined;

  // 1. Exact id or alias or name match
  for (const entity of OBJECT_PLACE_ENTITIES) {
    if (normalizeQuery(entity.id) === normalized || normalizeQuery(entity.name) === normalized) {
      return entity;
    }
    for (const alias of entity.aliases) {
      if (normalizeQuery(alias) === normalized) {
        return entity;
      }
    }
  }

  // 2. Fuzzy / keyword match
  return OBJECT_PLACE_ENTITIES.find((entity) => {
    if (normalizeQuery(entity.subCategory) === normalized) return true;
    if (matchesWordOrSubstring(entity.name, normalized)) return true;
    if (entity.aliases.some((alias) => matchesWordOrSubstring(alias, normalized))) return true;
    return entity.keyComponents.some((comp) => matchesWordOrSubstring(comp, normalized));
  });
}

/**
 * Lists all registered object, place, and material entities.
 */
export function listSpatialEntities(category?: ObjectPlaceEntity['category']): readonly ObjectPlaceEntity[] {
  if (!category) return OBJECT_PLACE_ENTITIES;
  return OBJECT_PLACE_ENTITIES.filter((entity) => entity.category === category);
}

/**
 * Retrieves specific sexually dimorphic anatomical comparisons between male and female anatomy.
 */
export function getSexualDimorphismMap(): Record<string, { female: string; male: string }> {
  const result: Record<string, { female: string; male: string }> = {};
  for (const landmark of HUMAN_LANDMARKS) {
    if (landmark.dimorphicFeatures?.female && landmark.dimorphicFeatures?.male) {
      result[landmark.name] = {
        female: landmark.dimorphicFeatures.female,
        male: landmark.dimorphicFeatures.male,
      };
    }
  }
  return result;
}

/**
 * Validates whether a detected bounding box is spatially plausible for a named anatomical landmark
 * on a standard frontal or profile view.
 */
export function validateAnatomicalSpatialPlacement(
  landmarkIdOrName: string,
  box: NormalizedBoundingBox,
  view: 'anterior' | 'posterior' | 'lateral' = 'anterior',
): { plausible: boolean; expectedBox?: NormalizedBoundingBox; reason?: string } {
  const queryResult = lookupAnatomicalLandmark(landmarkIdOrName);
  if (!queryResult.found || !queryResult.landmark) {
    return { plausible: true, reason: 'Unknown landmark; cannot enforce spatial constraint.' };
  }

  const expected = queryResult.landmark.canonicalCoordinates[view];
  if (!expected) {
    return { plausible: true, reason: `No canonical coordinates registered for ${view} view.` };
  }

  // Check vertical alignment tolerance: allow reasonable variance for posture and framing
  const verticalOverlap = Math.max(0, Math.min(box.bottom, expected.bottom + 0.15) - Math.max(box.top, expected.top - 0.15));
  if (verticalOverlap <= 0) {
    return {
      plausible: false,
      expectedBox: expected,
      reason: `Detected box top=${box.top.toFixed(2)}, bottom=${box.bottom.toFixed(2)} does not align vertically with expected ${queryResult.landmark.name} range [${expected.top}, ${expected.bottom}].`,
    };
  }

  return { plausible: true, expectedBox: expected };
}
