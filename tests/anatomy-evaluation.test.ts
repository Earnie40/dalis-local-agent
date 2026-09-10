import { describe, expect, it } from 'vitest';
import {
  lookupAnatomicalLandmark,
  lookupAnimalLandmark,
  lookupSpatialEntity,
  listAnatomicalLandmarks,
  listAnimalLandmarks,
  listSpatialEntities,
  getSexualDimorphismMap,
  validateAnatomicalSpatialPlacement,
  type AnatomicalLandmark,
  type NormalizedBoundingBox,
} from '@dacai-local-agent/domain-knowledge';
import { anatomyLocateTool } from '@dacai-local-agent/tools';

describe('Human Anatomy and Vision Grounding Engine', () => {
  describe('Female Anatomy Recognition and Localization', () => {
    it('identifies and localizes female mammary glands and breasts with exact coordinates', () => {
      const result = lookupAnatomicalLandmark('female breasts', 'female');
      expect(result.found).toBe(true);
      expect(result.landmark).toBeDefined();
      const landmark = result.landmark!;
      expect(landmark.primaryRegion).toBe('thorax');
      expect(landmark.subRegion).toBe('mammary');
      expect(landmark.genderSpecificity).toBe('female');

      // Canonical anterior coordinates are bounded between ribs 2 and 6
      const anterior = landmark.canonicalCoordinates.anterior!;
      expect(anterior.top).toBeGreaterThanOrEqual(0.20);
      expect(anterior.bottom).toBeLessThanOrEqual(0.38);
      expect(anterior.left).toBeGreaterThanOrEqual(0.30);
      expect(anterior.right).toBeLessThanOrEqual(0.70);

      // Verifies inframammary fold and pectoralis major adjacency
      expect(landmark.adjacentStructures).toContain('inframammary fold');
      expect(landmark.adjacentStructures).toContain('pectoralis major');
    });

    it('identifies female areola and nipple with correct relative placement and dimorphism', () => {
      const result = lookupAnatomicalLandmark('female nipple', 'female');
      expect(result.found).toBe(true);
      expect(result.landmark!.genderSpecificity).toBe('female');
      expect(result.landmark!.dimorphicFeatures?.female).toMatch(/areolar diameter|papilla/i);

      const anterior = result.landmark!.canonicalCoordinates.anterior!;
      expect(anterior.top).toBeGreaterThanOrEqual(0.25);
      expect(anterior.bottom).toBeLessThanOrEqual(0.33);
    });

    it('identifies gynecoid pelvis and hip architecture with waist-to-hip dimorphism', () => {
      const result = lookupAnatomicalLandmark('female pelvis', 'female');
      expect(result.found).toBe(true);
      expect(result.landmark!.subRegion).toBe('pelvic_girdle');
      expect(result.landmark!.dimorphicFeatures?.female).toMatch(/waist-to-hip|bitrochanteric|pubic arch/i);

      const anterior = result.landmark!.canonicalCoordinates.anterior!;
      expect(anterior.top).toBeGreaterThanOrEqual(0.40);
      expect(anterior.bottom).toBeLessThanOrEqual(0.60);
    });

    it('identifies female external genitalia and perineal structures', () => {
      const result = lookupAnatomicalLandmark('vulva', 'female');
      expect(result.found).toBe(true);
      expect(result.landmark!.system).toBe('urogenital');
      expect(result.landmark!.primaryRegion).toBe('pelvis');
      expect(result.landmark!.subRegion).toBe('perineum');
      expect(result.landmark!.adjacentStructures).toContain('mons pubis');
      expect(result.landmark!.adjacentStructures).toContain('perineal body');
    });

    it('distinguishes female craniofacial features (forehead, chin, and neck smoothness)', () => {
      const chin = lookupAnatomicalLandmark('chin');
      expect(chin.found).toBe(true);
      expect(chin.landmark!.dimorphicFeatures?.female).toMatch(/pointed|rounded|tapered|gonial/i);

      const neck = lookupAnatomicalLandmark('neck');
      expect(neck.found).toBe(true);
      expect(neck.landmark!.dimorphicFeatures?.female).toMatch(/slender|smooth/i);
    });
  });

  describe('Male Anatomy Recognition and Localization', () => {
    it("identifies and localizes the laryngeal prominence (Adam's apple) as male dimorphic landmark", () => {
      const result = lookupAnatomicalLandmark("adam's apple");
      expect(result.found).toBe(true);
      expect(result.landmark!.primaryRegion).toBe('cervical');
      expect(result.landmark!.genderSpecificity).toBe('male');
      expect(result.landmark!.dimorphicFeatures?.male).toMatch(/acute|protruding|prominence/i);

      const anterior = result.landmark!.canonicalCoordinates.anterior!;
      expect(anterior.top).toBeGreaterThanOrEqual(0.16);
      expect(anterior.bottom).toBeLessThanOrEqual(0.23);
    });

    it('identifies male pectoral musculature and male nipple placement', () => {
      const pecs = lookupAnatomicalLandmark('male chest', 'male');
      expect(pecs.found).toBe(true);
      expect(pecs.landmark!.system).toBe('muscular');
      expect(pecs.landmark!.primaryRegion).toBe('thorax');
      expect(pecs.landmark!.dimorphicFeatures?.male).toMatch(/muscular|axillary fold|pectoral/i);

      const nipple = lookupAnatomicalLandmark('male nipple', 'male');
      expect(nipple.found).toBe(true);
      expect(nipple.landmark!.genderSpecificity).toBe('male');
    });

    it('identifies android pelvis and narrower pelvic architecture', () => {
      const result = lookupAnatomicalLandmark('male pelvis', 'male');
      expect(result.found).toBe(true);
      expect(result.landmark!.subRegion).toBe('pelvic_girdle');
      expect(result.landmark!.description).toMatch(/android/i);
    });

    it('identifies male external genitalia (penis, scrotum, perineal raphe)', () => {
      const result = lookupAnatomicalLandmark('penis', 'male');
      expect(result.found).toBe(true);
      expect(result.landmark!.system).toBe('urogenital');
      expect(result.landmark!.subRegion).toBe('perineum');
      expect(result.landmark!.adjacentStructures).toContain('scrotum');
    });

    it('identifies male craniofacial characteristics (brow ridge, jawline, chin)', () => {
      const brow = lookupAnatomicalLandmark('forehead');
      expect(brow.found).toBe(true);
      expect(brow.landmark!.dimorphicFeatures?.male).toMatch(/supraorbital|sloped/i);

      const chin = lookupAnatomicalLandmark('mandible');
      expect(chin.found).toBe(true);
      expect(chin.landmark!.dimorphicFeatures?.male).toMatch(/squarer|flared gonial|angular/i);
    });
  });

  describe('Shared Axial and Appendicular Human Anatomy', () => {
    it('identifies upper extremity landmarks from shoulder to digits', () => {
      const shoulder = lookupAnatomicalLandmark('shoulder');
      const arm = lookupAnatomicalLandmark('biceps');
      const elbow = lookupAnatomicalLandmark('elbow');
      const forearm = lookupAnatomicalLandmark('forearm');
      const wrist = lookupAnatomicalLandmark('wrist');

      expect(shoulder.found).toBe(true);
      expect(arm.found).toBe(true);
      expect(elbow.found).toBe(true);
      expect(forearm.found).toBe(true);
      expect(wrist.found).toBe(true);

      // Verify spatial progression along limb (shoulder -> arm -> elbow -> forearm -> hand)
      expect(shoulder.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        arm.landmark!.canonicalCoordinates.anterior!.top,
      );
      expect(arm.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        elbow.landmark!.canonicalCoordinates.anterior!.top,
      );
      expect(elbow.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        wrist.landmark!.canonicalCoordinates.anterior!.top,
      );
    });

    it('identifies lower extremity landmarks from hip to foot', () => {
      const thigh = lookupAnatomicalLandmark('thigh');
      const knee = lookupAnatomicalLandmark('knee');
      const calf = lookupAnatomicalLandmark('calf');
      const foot = lookupAnatomicalLandmark('foot');

      expect(thigh.found).toBe(true);
      expect(knee.found).toBe(true);
      expect(calf.found).toBe(true);
      expect(foot.found).toBe(true);

      expect(thigh.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        knee.landmark!.canonicalCoordinates.anterior!.top,
      );
      expect(knee.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        calf.landmark!.canonicalCoordinates.anterior!.top,
      );
      expect(calf.landmark!.canonicalCoordinates.anterior!.top).toBeLessThan(
        foot.landmark!.canonicalCoordinates.anterior!.top,
      );
    });

    it('identifies abdominal landmarks including the umbilicus and rectus abdominis', () => {
      const abs = lookupAnatomicalLandmark('rectus abdominis');
      const navel = lookupAnatomicalLandmark('navel');

      expect(abs.found).toBe(true);
      expect(navel.found).toBe(true);
      expect(navel.landmark!.primaryRegion).toBe('abdomen');
      expect(navel.landmark!.subRegion).toBe('umbilical_region');
    });

    it('identifies dorsal spine, scapulae, and gluteal landmarks', () => {
      const spine = lookupAnatomicalLandmark('spine');
      const glutes = lookupAnatomicalLandmark('buttocks');

      expect(spine.found).toBe(true);
      expect(glutes.found).toBe(true);
      expect(spine.landmark!.primaryRegion).toBe('dorsal');
      expect(glutes.landmark!.subRegion).toBe('buttocks');
    });
  });

  describe('Comparative Animal Anatomy', () => {
    it('identifies quadruped muzzle, withers, and topline', () => {
      const muzzle = lookupAnimalLandmark('muzzle');
      const withers = lookupAnimalLandmark('withers');

      expect(muzzle.found).toBe(true);
      expect(withers.found).toBe(true);
      expect(muzzle.comparativeAnimal!.region).toBe('cranial');
      expect(withers.comparativeAnimal!.region).toBe('thoracic_dorsal');
    });

    it('maps animal limb homologies correctly (stifle to knee, hock to heel/ankle)', () => {
      const stifle = lookupAnimalLandmark('stifle');
      const hock = lookupAnimalLandmark('hock');
      const carpus = lookupAnimalLandmark('carpus');

      expect(stifle.found).toBe(true);
      expect(hock.found).toBe(true);
      expect(carpus.found).toBe(true);

      expect(stifle.comparativeAnimal!.homologueToHuman).toMatch(/knee/i);
      expect(hock.comparativeAnimal!.homologueToHuman).toMatch(/ankle|heel|calcaneus/i);
      expect(carpus.comparativeAnimal!.homologueToHuman).toMatch(/wrist/i);
    });

    it('identifies avian beak and wing structures', () => {
      const beak = lookupAnimalLandmark('beak');
      const wing = lookupAnimalLandmark('wing');

      expect(beak.found).toBe(true);
      expect(wing.found).toBe(true);
      expect(wing.comparativeAnimal!.homologueToHuman).toMatch(/arm|forearm|digits/i);
    });
  });

  describe('Spatial Entities: Objects, Places, and Things', () => {
    it('identifies vehicles and mechanical objects with structural components', () => {
      const car = lookupSpatialEntity('car');
      expect(car).toBeDefined();
      expect(car!.category).toBe('object');
      expect(car!.keyComponents).toContain('windshield');
      expect(car!.keyComponents).toContain('wheels/tires');

      const tool = lookupSpatialEntity('hammer');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('object');
      expect(tool!.keyComponents).toContain('handle/grip');
    });

    it('identifies indoor architectural and outdoor natural places', () => {
      const room = lookupSpatialEntity('room');
      expect(room).toBeDefined();
      expect(room!.category).toBe('place');
      expect(room!.keyComponents).toContain('floor plane');
      expect(room!.keyComponents).toContain('vertical wall boundaries');

      const landscape = lookupSpatialEntity('mountains');
      expect(landscape).toBeDefined();
      expect(landscape!.category).toBe('place');
      expect(landscape!.keyComponents).toContain('horizon boundary');
    });

    it('identifies material properties (human skin and textiles)', () => {
      const skin = lookupSpatialEntity('skin');
      expect(skin).toBeDefined();
      expect(skin!.category).toBe('thing');
      expect(skin!.visualProperties.some((p) => p.includes('subsurface scattering'))).toBe(true);

      const fabric = lookupSpatialEntity('fabrics');
      expect(fabric).toBeDefined();
      expect(fabric!.category).toBe('thing');
    });
  });

  describe('Spatial Bounding Box Validation', () => {
    it('approves spatially plausible detection boxes', () => {
      // Cranium placed in head zone [0.01 .. 0.14]
      const validCraniumBox: NormalizedBoundingBox = { left: 0.40, top: 0.02, right: 0.60, bottom: 0.13 };
      const check = validateAnatomicalSpatialPlacement('cranium', validCraniumBox, 'anterior');
      expect(check.plausible).toBe(true);

      // Knees placed in lower extremity zone [0.70 .. 0.77]
      const validKneeBox: NormalizedBoundingBox = { left: 0.38, top: 0.68, right: 0.62, bottom: 0.78 };
      const kneeCheck = validateAnatomicalSpatialPlacement('knee', validKneeBox, 'anterior');
      expect(kneeCheck.plausible).toBe(true);
    });

    it('rejects biologically impossible coordinate detections', () => {
      // Patella/knee placed on the head (top=0.02, bottom=0.10)
      const impossibleKneeOnHead: NormalizedBoundingBox = { left: 0.40, top: 0.02, right: 0.60, bottom: 0.10 };
      const check = validateAnatomicalSpatialPlacement('knee', impossibleKneeOnHead, 'anterior');
      expect(check.plausible).toBe(false);
      expect(check.reason).toMatch(/does not align vertically/i);

      // Eyes placed near feet (top=0.90, bottom=0.95)
      const impossibleEyesAtFeet: NormalizedBoundingBox = { left: 0.45, top: 0.90, right: 0.55, bottom: 0.95 };
      const eyeCheck = validateAnatomicalSpatialPlacement('eyes', impossibleEyesAtFeet, 'anterior');
      expect(eyeCheck.plausible).toBe(false);
    });
  });

  describe('Anatomy Locate Tool (Agent Integration)', () => {
    it('executes anatomy.locate tool successfully for female breast query', async () => {
      const result = await anatomyLocateTool.execute(
        { query: 'female breasts', gender: 'female', view: 'anterior' },
        { workspaceRoot: process.cwd() },
      );
      expect(result.type).toBe('human_anatomy');
      expect(result.landmarkId).toBe('anat_female_breasts');
      expect(result.primaryRegion).toBe('thorax');
      expect(result.canonicalCoordinates).toBeDefined();
    });

    it('executes anatomy.locate tool for male chest with spatial validation', async () => {
      const result = await anatomyLocateTool.execute(
        {
          query: 'male chest',
          gender: 'male',
          view: 'anterior',
          box: { left: 0.35, top: 0.23, right: 0.65, bottom: 0.32 },
        },
        { workspaceRoot: process.cwd() },
      );
      expect(result.type).toBe('human_anatomy');
      expect(result.spatialValidation?.plausible).toBe(true);
    });

    it('executes anatomy.locate tool for animal stifle joint', async () => {
      const result = await anatomyLocateTool.execute(
        { query: 'stifle' },
        { workspaceRoot: process.cwd() },
      );
      expect(result.type).toBe('comparative_animal_anatomy');
      expect(result.homologueToHuman).toMatch(/knee/i);
    });

    it('executes anatomy.locate tool for spatial object (vehicle)', async () => {
      const result = await anatomyLocateTool.execute(
        { query: 'car' },
        { workspaceRoot: process.cwd() },
      );
      expect(result.type).toBe('object');
      expect(result.keyComponents).toContain('windshield');
    });
  });
});
