import { z } from "zod";
import {
  readResource,
  vreadResource,
  createResource,
  updateResource,
  patchResource,
  deleteResource,
  searchResource,
  getResourceHistory,
  getTypeHistory,
  getCapabilityStatement,
  executeOperation,
  executeTransaction,
  getPatientEverything,
  validateResource,
} from "./fhir-client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown) => Promise<string>;
}

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── Common schemas ─────────────────────────────────────────────────────────────

const ResourceTypeSchema = z
  .string()
  .describe(
    "FHIR R4 resource type (e.g. Patient, Observation, Condition, Encounter, Practitioner, " +
      "Organization, Medication, MedicationRequest, AllergyIntolerance, Immunization, " +
      "DiagnosticReport, Procedure, ServiceRequest, Coverage, RelatedPerson, Device, " +
      "Location, Appointment, Slot, Schedule, Specimen, Substance, etc.)"
  );

const SearchParamsSchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .optional()
  .describe(
    "FHIR search parameters as key-value pairs. Values can be strings or arrays of strings. " +
      "Example: { '_id': '123', 'status': 'active', 'category': ['vital-signs', 'laboratory'] }"
  );

// ── Tool definitions ───────────────────────────────────────────────────────────

export const tools: ToolDefinition[] = [
  // ── Capability Statement ──────────────────────────────────────────────────
  {
    name: "fhir_get_metadata",
    description:
      "Retrieve the FHIR server capability statement (TerminologyCapabilities / CapabilityStatement). " +
      "Describes supported resources, operations, search parameters, and server features.",
    inputSchema: z.object({}),
    async handler() {
      const result = await getCapabilityStatement();
      return jsonResult(result);
    },
  },

  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: "fhir_read_resource",
    description:
      "Read a single FHIR R4 resource by its resource type and logical ID. " +
      "Returns the current version of the resource.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource"),
    }),
    async handler(input) {
      const { resourceType, id } = input as { resourceType: string; id: string };
      const result = await readResource(resourceType, id);
      return jsonResult(result);
    },
  },

  // ── Version Read ──────────────────────────────────────────────────────────
  {
    name: "fhir_vread_resource",
    description:
      "Read a specific historical version of a FHIR R4 resource by type, logical ID, and version ID.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource"),
      versionId: z.string().describe("Version ID (from resource meta.versionId)"),
    }),
    async handler(input) {
      const { resourceType, id, versionId } = input as {
        resourceType: string;
        id: string;
        versionId: string;
      };
      const result = await vreadResource(resourceType, id, versionId);
      return jsonResult(result);
    },
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    name: "fhir_search_resources",
    description:
      "Search for FHIR R4 resources of a given type using standard FHIR search parameters. " +
      "Supports all FHIR search modifiers, chaining, and result controls (_count, _sort, _include, etc.).",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      searchParams: SearchParamsSchema,
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results to return (_count)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of results to skip (_offset)"),
      sort: z
        .string()
        .optional()
        .describe(
          "Comma-separated sort parameters. Prefix with '-' for descending. E.g. '-date,name'"
        ),
      includes: z
        .array(z.string())
        .optional()
        .describe("Resources to include (_include). E.g. ['MedicationRequest:medication']"),
      revIncludes: z
        .array(z.string())
        .optional()
        .describe(
          "Reverse includes (_revinclude). E.g. ['Provenance:target']"
        ),
      summary: z
        .enum(["true", "text", "data", "count", "false"])
        .optional()
        .describe("Summary mode (_summary)"),
      elements: z
        .array(z.string())
        .optional()
        .describe("Subset of elements to return (_elements). E.g. ['id', 'name', 'birthDate']"),
    }),
    async handler(input) {
      const { resourceType, searchParams, count, offset, sort, includes, revIncludes, summary, elements } =
        input as {
          resourceType: string;
          searchParams?: Record<string, string | string[]>;
          count?: number;
          offset?: number;
          sort?: string;
          includes?: string[];
          revIncludes?: string[];
          summary?: "true" | "text" | "data" | "count" | "false";
          elements?: string[];
        };
      const result = await searchResource({
        resourceType,
        searchParams,
        count,
        offset,
        sort,
        includes,
        revIncludes,
        summary,
        elements,
      });
      return jsonResult(result);
    },
  },

  // ── Create ────────────────────────────────────────────────────────────────
  {
    name: "fhir_create_resource",
    description:
      "Create a new FHIR R4 resource on the server. The server assigns the logical ID. " +
      "Returns the created resource with server-assigned id and meta.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      resource: z
        .record(z.unknown())
        .describe("Full FHIR R4 resource object. Must include resourceType field."),
    }),
    async handler(input) {
      const { resourceType, resource } = input as {
        resourceType: string;
        resource: Record<string, unknown>;
      };
      const result = await createResource(resourceType, resource);
      return jsonResult(result);
    },
  },

  // ── Update ────────────────────────────────────────────────────────────────
  {
    name: "fhir_update_resource",
    description:
      "Update (replace) an existing FHIR R4 resource using a full resource representation. " +
      "The resource body must include the same id as the path parameter.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource to update"),
      resource: z
        .record(z.unknown())
        .describe("Complete FHIR R4 resource object to replace the existing one"),
    }),
    async handler(input) {
      const { resourceType, id, resource } = input as {
        resourceType: string;
        id: string;
        resource: Record<string, unknown>;
      };
      const result = await updateResource(resourceType, id, resource);
      return jsonResult(result);
    },
  },

  // ── Patch ─────────────────────────────────────────────────────────────────
  {
    name: "fhir_patch_resource",
    description:
      "Partially update a FHIR R4 resource using JSON Patch (RFC 6902) or a FHIR Parameters patch. " +
      "JSON Patch is the default; pass patchType='fhir-patch' for a FHIR patch.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource to patch"),
      patch: z
        .unknown()
        .describe(
          "For json-patch: array of patch operations [{ op, path, value }]. " +
            "For fhir-patch: FHIR Parameters resource."
        ),
      patchType: z
        .enum(["json-patch", "fhir-patch"])
        .optional()
        .default("json-patch")
        .describe("Patch format to use"),
    }),
    async handler(input) {
      const { resourceType, id, patch, patchType } = input as {
        resourceType: string;
        id: string;
        patch: unknown;
        patchType?: "json-patch" | "fhir-patch";
      };
      const result = await patchResource(resourceType, id, patch, patchType ?? "json-patch");
      return jsonResult(result);
    },
  },

  // ── Delete ────────────────────────────────────────────────────────────────
  {
    name: "fhir_delete_resource",
    description: "Delete a FHIR R4 resource by type and logical ID.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource to delete"),
    }),
    async handler(input) {
      const { resourceType, id } = input as { resourceType: string; id: string };
      const result = await deleteResource(resourceType, id);
      return result
        ? jsonResult(result)
        : "Resource deleted successfully (204 No Content).";
    },
  },

  // ── Resource History ──────────────────────────────────────────────────────
  {
    name: "fhir_resource_history",
    description:
      "Retrieve the version history for a specific FHIR R4 resource instance.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      id: z.string().describe("Logical ID of the resource"),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of history entries to return"),
      since: z
        .string()
        .optional()
        .describe("Return history entries updated after this instant (ISO 8601)"),
    }),
    async handler(input) {
      const { resourceType, id, count, since } = input as {
        resourceType: string;
        id: string;
        count?: number;
        since?: string;
      };
      const result = await getResourceHistory(resourceType, id, count, since);
      return jsonResult(result);
    },
  },

  // ── Type History ──────────────────────────────────────────────────────────
  {
    name: "fhir_type_history",
    description:
      "Retrieve the change history for all resources of a given FHIR R4 type.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of history entries to return"),
      since: z
        .string()
        .optional()
        .describe("Return history entries updated after this instant (ISO 8601)"),
    }),
    async handler(input) {
      const { resourceType, count, since } = input as {
        resourceType: string;
        count?: number;
        since?: string;
      };
      const result = await getTypeHistory(resourceType, count, since);
      return jsonResult(result);
    },
  },

  // ── $everything ───────────────────────────────────────────────────────────
  {
    name: "fhir_patient_everything",
    description:
      "Invoke the FHIR $everything operation on a Patient to retrieve all resources " +
      "in the patient compartment (encounters, observations, conditions, medications, etc.).",
    inputSchema: z.object({
      patientId: z.string().describe("Logical ID of the Patient resource"),
      start: z
        .string()
        .optional()
        .describe("Start date for filtering (ISO 8601 date or dateTime)"),
      end: z
        .string()
        .optional()
        .describe("End date for filtering (ISO 8601 date or dateTime)"),
      types: z
        .array(z.string())
        .optional()
        .describe("Resource types to include (e.g. ['Observation', 'Condition'])"),
      count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Page size for the response bundle"),
    }),
    async handler(input) {
      const { patientId, start, end, types, count } = input as {
        patientId: string;
        start?: string;
        end?: string;
        types?: string[];
        count?: number;
      };
      const params: Record<string, string> = {};
      if (start) params["start"] = start;
      if (end) params["end"] = end;
      if (types?.length) params["_type"] = types.join(",");
      if (count !== undefined) params["_count"] = String(count);
      const result = await getPatientEverything(patientId, params);
      return jsonResult(result);
    },
  },

  // ── $validate ─────────────────────────────────────────────────────────────
  {
    name: "fhir_validate_resource",
    description:
      "Invoke the FHIR $validate operation to validate a resource against the base FHIR R4 " +
      "specification or an optional StructureDefinition profile URL.",
    inputSchema: z.object({
      resourceType: ResourceTypeSchema,
      resource: z.record(z.unknown()).describe("FHIR resource to validate"),
      profile: z
        .string()
        .optional()
        .describe("Canonical URL of a StructureDefinition profile to validate against"),
    }),
    async handler(input) {
      const { resourceType, resource, profile } = input as {
        resourceType: string;
        resource: Record<string, unknown>;
        profile?: string;
      };
      const result = await validateResource(resourceType, resource, profile);
      return jsonResult(result);
    },
  },

  // ── Generic Operation ─────────────────────────────────────────────────────
  {
    name: "fhir_execute_operation",
    description:
      "Invoke a named FHIR operation (e.g. $expand, $lookup, $translate, $validate-code, $closure, " +
      "$everything, $match, $apply, $process-message). Supports system, type, and instance level operations.",
    inputSchema: z.object({
      operation: z
        .string()
        .describe("Operation name without the leading '$' (e.g. 'expand', 'lookup')"),
      resourceType: z
        .string()
        .optional()
        .describe("FHIR resource type for type-level or instance-level operations"),
      id: z
        .string()
        .optional()
        .describe("Resource ID for instance-level operations"),
      body: z
        .unknown()
        .optional()
        .describe(
          "Request body (usually a FHIR Parameters resource) for POST-based operations"
        ),
    }),
    async handler(input) {
      const { operation, resourceType, id, body } = input as {
        operation: string;
        resourceType?: string;
        id?: string;
        body?: unknown;
      };
      const result = await executeOperation(operation, resourceType, id, body);
      return jsonResult(result);
    },
  },

  // ── Transaction / Batch ───────────────────────────────────────────────────
  {
    name: "fhir_transaction",
    description:
      "Submit a FHIR Bundle of type 'transaction' or 'batch' to the server. " +
      "Transactions are atomic; batches process each entry independently.",
    inputSchema: z.object({
      bundle: z
        .record(z.unknown())
        .describe(
          "FHIR Bundle resource with type 'transaction' or 'batch'. " +
            "Each entry should include a request object with method and url."
        ),
    }),
    async handler(input) {
      const { bundle } = input as { bundle: Record<string, unknown> };
      const result = await executeTransaction(bundle);
      return jsonResult(result);
    },
  },

  // ── Convenience: Patient search ───────────────────────────────────────────
  {
    name: "fhir_search_patients",
    description:
      "Convenience tool to search for Patient resources using common demographic parameters.",
    inputSchema: z.object({
      family: z.string().optional().describe("Family (last) name"),
      given: z.string().optional().describe("Given (first) name"),
      birthdate: z
        .string()
        .optional()
        .describe("Date of birth (YYYY-MM-DD or with modifiers e.g. 'ge1990-01-01')"),
      gender: z
        .enum(["male", "female", "other", "unknown"])
        .optional()
        .describe("Administrative gender"),
      identifier: z
        .string()
        .optional()
        .describe("Patient identifier (system|value or value)"),
      telecom: z.string().optional().describe("Phone number or email"),
      address: z.string().optional().describe("Address string search"),
      count: z.number().int().positive().optional().default(20),
    }),
    async handler(input) {
      const { family, given, birthdate, gender, identifier, telecom, address, count } =
        input as {
          family?: string;
          given?: string;
          birthdate?: string;
          gender?: string;
          identifier?: string;
          telecom?: string;
          address?: string;
          count?: number;
        };
      const params: Record<string, string> = {};
      if (family) params["family"] = family;
      if (given) params["given"] = given;
      if (birthdate) params["birthdate"] = birthdate;
      if (gender) params["gender"] = gender;
      if (identifier) params["identifier"] = identifier;
      if (telecom) params["telecom"] = telecom;
      if (address) params["address"] = address;
      const result = await searchResource({
        resourceType: "Patient",
        searchParams: params,
        count: count ?? 20,
      });
      return jsonResult(result);
    },
  },

  // ── Convenience: Observation search ──────────────────────────────────────
  {
    name: "fhir_search_observations",
    description:
      "Convenience tool to search for Observation resources (lab results, vitals, etc.).",
    inputSchema: z.object({
      patientId: z.string().optional().describe("Patient logical ID"),
      code: z
        .string()
        .optional()
        .describe("Observation code (LOINC, SNOMED, or system|code)"),
      category: z
        .string()
        .optional()
        .describe(
          "Category code (e.g. 'vital-signs', 'laboratory', 'social-history', 'imaging')"
        ),
      dateStart: z
        .string()
        .optional()
        .describe("Observation date >= this value (ISO 8601)"),
      dateEnd: z
        .string()
        .optional()
        .describe("Observation date <= this value (ISO 8601)"),
      status: z
        .string()
        .optional()
        .describe("Status (registered|preliminary|final|amended|corrected|cancelled|entered-in-error|unknown)"),
      count: z.number().int().positive().optional().default(20),
    }),
    async handler(input) {
      const { patientId, code, category, dateStart, dateEnd, status, count } = input as {
        patientId?: string;
        code?: string;
        category?: string;
        dateStart?: string;
        dateEnd?: string;
        status?: string;
        count?: number;
      };
      const params: Record<string, string | string[]> = {};
      if (patientId) params["patient"] = patientId;
      if (code) params["code"] = code;
      if (category) params["category"] = category;
      if (status) params["status"] = status;
      const dateFilters: string[] = [];
      if (dateStart) dateFilters.push(`ge${dateStart}`);
      if (dateEnd) dateFilters.push(`le${dateEnd}`);
      if (dateFilters.length) params["date"] = dateFilters;
      const result = await searchResource({
        resourceType: "Observation",
        searchParams: params,
        count: count ?? 20,
        sort: "-date",
      });
      return jsonResult(result);
    },
  },

  // ── Convenience: Conditions search ───────────────────────────────────────
  {
    name: "fhir_search_conditions",
    description:
      "Convenience tool to search for Condition (problem/diagnosis) resources.",
    inputSchema: z.object({
      patientId: z.string().optional().describe("Patient logical ID"),
      code: z
        .string()
        .optional()
        .describe("Condition code (ICD-10, SNOMED, or system|code)"),
      clinicalStatus: z
        .string()
        .optional()
        .describe("Clinical status (active|recurrence|relapse|inactive|remission|resolved)"),
      category: z
        .string()
        .optional()
        .describe("Category (problem-list-item|encounter-diagnosis)"),
      onsetDateStart: z.string().optional().describe("Onset date >= (ISO 8601)"),
      onsetDateEnd: z.string().optional().describe("Onset date <= (ISO 8601)"),
      count: z.number().int().positive().optional().default(20),
    }),
    async handler(input) {
      const { patientId, code, clinicalStatus, category, onsetDateStart, onsetDateEnd, count } =
        input as {
          patientId?: string;
          code?: string;
          clinicalStatus?: string;
          category?: string;
          onsetDateStart?: string;
          onsetDateEnd?: string;
          count?: number;
        };
      const params: Record<string, string | string[]> = {};
      if (patientId) params["patient"] = patientId;
      if (code) params["code"] = code;
      if (clinicalStatus) params["clinical-status"] = clinicalStatus;
      if (category) params["category"] = category;
      const dateFilters: string[] = [];
      if (onsetDateStart) dateFilters.push(`ge${onsetDateStart}`);
      if (onsetDateEnd) dateFilters.push(`le${onsetDateEnd}`);
      if (dateFilters.length) params["onset-date"] = dateFilters;
      const result = await searchResource({
        resourceType: "Condition",
        searchParams: params,
        count: count ?? 20,
      });
      return jsonResult(result);
    },
  },

  // ── Convenience: MedicationRequest search ────────────────────────────────
  {
    name: "fhir_search_medication_requests",
    description:
      "Convenience tool to search for MedicationRequest (prescription/order) resources.",
    inputSchema: z.object({
      patientId: z.string().optional().describe("Patient logical ID"),
      status: z
        .string()
        .optional()
        .describe(
          "Request status (active|on-hold|cancelled|completed|entered-in-error|stopped|draft|unknown)"
        ),
      intent: z
        .string()
        .optional()
        .describe("Intent (proposal|plan|order|original-order|reflex-order|filler-order|instance-order|option)"),
      code: z
        .string()
        .optional()
        .describe(
          "Medication code as system|code or code (RxNorm etc.). In R4 this searches " +
            "MedicationRequest.medicationCodeableConcept."
        ),
      medication: z
        .string()
        .optional()
        .describe(
          "Medication reference, e.g. 'Medication/123'. In R4 this searches " +
            "MedicationRequest.medicationReference; use 'code' for a coded medication."
        ),
      authoredon: z
        .string()
        .optional()
        .describe("Date authored (ISO 8601, may include modifiers)"),
      count: z.number().int().positive().optional().default(20),
    }),
    async handler(input) {
      const { patientId, status, intent, code, medication, authoredon, count } = input as {
        patientId?: string;
        status?: string;
        intent?: string;
        code?: string;
        medication?: string;
        authoredon?: string;
        count?: number;
      };
      const params: Record<string, string> = {};
      if (patientId) params["patient"] = patientId;
      if (status) params["status"] = status;
      if (intent) params["intent"] = intent;
      if (code) params["code"] = code;
      if (medication) params["medication"] = medication;
      if (authoredon) params["authoredon"] = authoredon;
      const result = await searchResource({
        resourceType: "MedicationRequest",
        searchParams: params,
        count: count ?? 20,
        sort: "-authoredon",
      });
      return jsonResult(result);
    },
  },

  // ── Convenience: Encounter search ────────────────────────────────────────
  {
    name: "fhir_search_encounters",
    description:
      "Convenience tool to search for Encounter resources (visits, admissions, etc.).",
    inputSchema: z.object({
      patientId: z.string().optional().describe("Patient logical ID"),
      status: z
        .string()
        .optional()
        .describe(
          "Encounter status (planned|arrived|triaged|in-progress|onleave|finished|cancelled|entered-in-error|unknown)"
        ),
      class: z
        .string()
        .optional()
        .describe("Encounter class code (AMB, IMP, EMER, etc.)"),
      type: z.string().optional().describe("Encounter type code"),
      dateStart: z.string().optional().describe("Date >= (ISO 8601)"),
      dateEnd: z.string().optional().describe("Date <= (ISO 8601)"),
      count: z.number().int().positive().optional().default(20),
    }),
    async handler(input) {
      const { patientId, status, class: cls, type, dateStart, dateEnd, count } = input as {
        patientId?: string;
        status?: string;
        class?: string;
        type?: string;
        dateStart?: string;
        dateEnd?: string;
        count?: number;
      };
      const params: Record<string, string | string[]> = {};
      if (patientId) params["patient"] = patientId;
      if (status) params["status"] = status;
      if (cls) params["class"] = cls;
      if (type) params["type"] = type;
      const dateFilters: string[] = [];
      if (dateStart) dateFilters.push(`ge${dateStart}`);
      if (dateEnd) dateFilters.push(`le${dateEnd}`);
      if (dateFilters.length) params["date"] = dateFilters;
      const result = await searchResource({
        resourceType: "Encounter",
        searchParams: params,
        count: count ?? 20,
        sort: "-date",
      });
      return jsonResult(result);
    },
  },
];
