import type { ReactElement } from "react";

import type { SiteConfig } from "@sitepilot/contracts";

function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function listToLines(values: string[]): string {
  return values.join("\n");
}

export type SiteConfigFormProps = {
  value: SiteConfig;
  onChange: (next: SiteConfig) => void;
};

export function SiteConfigForm({
  value,
  onChange
}: SiteConfigFormProps): ReactElement {
  const s = value.sections;

  return (
    <div className="config-form">
      <fieldset className="config-fieldset">
        <legend>Record</legend>
        <label className="field">
          <span>Config id</span>
          <input readOnly value={value.id} />
        </label>
        <label className="field">
          <span>Version</span>
          <input readOnly value={String(value.version)} />
        </label>
        <label className="field">
          <span>Site id</span>
          <input readOnly value={value.siteId} />
        </label>
        <label className="field">
          <span>Created</span>
          <input readOnly value={value.createdAt} />
        </label>
        <label className="field">
          <span>Updated</span>
          <input readOnly value={value.updatedAt} />
        </label>
        <label className="field">
          <span>Activation (document)</span>
          <input readOnly value={value.activationStatus} />
        </label>
        <label className="field">
          <span>Required sections complete</span>
          <input
            readOnly
            value={value.requiredSectionsComplete ? "yes" : "no"}
          />
        </label>
        {value.metadata.generatedFromDiscoverySnapshotId ? (
          <label className="field">
            <span>Generated from discovery snapshot</span>
            <input
              readOnly
              value={value.metadata.generatedFromDiscoverySnapshotId}
            />
          </label>
        ) : null}
        <label className="field">
          <span>Notes (one per line)</span>
          <textarea
            rows={4}
            value={listToLines(value.metadata.notes)}
            onChange={(e) =>
              onChange({
                ...value,
                metadata: {
                  ...value.metadata,
                  notes: linesToList(e.target.value)
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Identity</legend>
        <label className="field">
          <span>Site name</span>
          <input
            value={s.identity.siteName}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  identity: { ...s.identity, siteName: e.target.value }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input
            value={s.identity.baseUrl}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  identity: { ...s.identity, baseUrl: e.target.value }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Business description</span>
          <textarea
            rows={3}
            value={s.identity.businessDescription}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  identity: {
                    ...s.identity,
                    businessDescription: e.target.value
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Audience summary</span>
          <textarea
            rows={2}
            value={s.identity.audienceSummary}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  identity: {
                    ...s.identity,
                    audienceSummary: e.target.value
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Structure</legend>
        <label className="field">
          <span>Public sections (one per line)</span>
          <textarea
            rows={3}
            value={listToLines(s.structure.publicSections)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  structure: {
                    ...s.structure,
                    publicSections: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Restricted templates (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.structure.restrictedTemplates)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  structure: {
                    ...s.structure,
                    restrictedTemplates: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Page tree summary</span>
          <textarea
            rows={3}
            value={s.structure.pageTreeSummary}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  structure: {
                    ...s.structure,
                    pageTreeSummary: e.target.value
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Content model</legend>
        <label className="field">
          <span>Editable post types (one per line)</span>
          <textarea
            rows={3}
            value={listToLines(s.contentModel.editablePostTypes)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentModel: {
                    ...s.contentModel,
                    editablePostTypes: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Read-only post types (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.contentModel.readOnlyPostTypes)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentModel: {
                    ...s.contentModel,
                    readOnlyPostTypes: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Taxonomy definitions (one per line)</span>
          <textarea
            rows={3}
            value={listToLines(s.contentModel.taxonomyDefinitions)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentModel: {
                    ...s.contentModel,
                    taxonomyDefinitions: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Third-party blocks discovered (read-only)</span>
          <textarea
            rows={4}
            readOnly
            value={listToLines(s.contentModel.thirdPartyBlocks)}
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>SEO policy</legend>
        <label className="field">
          <span>SEO meta provider</span>
          <select
            value={s.seoPolicy.metaProvider}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  seoPolicy: {
                    ...s.seoPolicy,
                    metaProvider:
                      e.target.value === "yoast" ? "yoast" : "sitepilot"
                  }
                }
              })
            }
          >
            <option value="sitepilot">SitePilot default meta fields</option>
            <option value="yoast">Yoast SEO meta fields</option>
          </select>
        </label>
        <label className="field">
          <span>Title patterns (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.seoPolicy.titlePatterns)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  seoPolicy: {
                    ...s.seoPolicy,
                    titlePatterns: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.seoPolicy.redirectsRequireApproval}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  seoPolicy: {
                    ...s.seoPolicy,
                    redirectsRequireApproval: e.target.checked
                  }
                }
              })
            }
          />
          <span>Redirects require approval</span>
        </label>
        <label className="field">
          <span>Internal linking expectation</span>
          <textarea
            rows={2}
            value={s.seoPolicy.internalLinkingExpectation}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  seoPolicy: {
                    ...s.seoPolicy,
                    internalLinkingExpectation: e.target.value
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Media policy</legend>
        <label className="field">
          <span>Accepted formats (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.mediaPolicy.acceptedFormats)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  mediaPolicy: {
                    ...s.mediaPolicy,
                    acceptedFormats: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.mediaPolicy.altTextRequired}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  mediaPolicy: {
                    ...s.mediaPolicy,
                    altTextRequired: e.target.checked
                  }
                }
              })
            }
          />
          <span>Alt text required</span>
        </label>
        <label className="field">
          <span>Featured image required post types (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.mediaPolicy.featuredImageRequiredPostTypes)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  mediaPolicy: {
                    ...s.mediaPolicy,
                    featuredImageRequiredPostTypes: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Approval policy</legend>
        <label className="field">
          <span>Auto-approve categories (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.approvalPolicy.autoApproveCategories)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  approvalPolicy: {
                    ...s.approvalPolicy,
                    autoApproveCategories: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.approvalPolicy.publishRequiresApproval}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  approvalPolicy: {
                    ...s.approvalPolicy,
                    publishRequiresApproval: e.target.checked
                  }
                }
              })
            }
          />
          <span>Publish requires approval</span>
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.approvalPolicy.menuChangesRequireApproval}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  approvalPolicy: {
                    ...s.approvalPolicy,
                    menuChangesRequireApproval: e.target.checked
                  }
                }
              })
            }
          />
          <span>Menu changes require approval</span>
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Tool access</legend>
        <label className="field">
          <span>Enabled tools (one per line)</span>
          <textarea
            rows={3}
            value={listToLines(s.toolAccessPolicy.enabledTools)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  toolAccessPolicy: {
                    ...s.toolAccessPolicy,
                    enabledTools: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Disabled tools (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.toolAccessPolicy.disabledTools)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  toolAccessPolicy: {
                    ...s.toolAccessPolicy,
                    disabledTools: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Dry-run only tools (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.toolAccessPolicy.dryRunOnlyTools)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  toolAccessPolicy: {
                    ...s.toolAccessPolicy,
                    dryRunOnlyTools: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Content style</legend>
        <label className="field">
          <span>Tone</span>
          <input
            value={s.contentStylePolicy.tone}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentStylePolicy: {
                    ...s.contentStylePolicy,
                    tone: e.target.value
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Reading level</span>
          <input
            value={s.contentStylePolicy.readingLevel}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentStylePolicy: {
                    ...s.contentStylePolicy,
                    readingLevel: e.target.value
                  }
                }
              })
            }
          />
        </label>
        <label className="field">
          <span>Disallowed wording (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.contentStylePolicy.disallowedWording)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  contentStylePolicy: {
                    ...s.contentStylePolicy,
                    disallowedWording: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
      </fieldset>

      <fieldset className="config-fieldset">
        <legend>Guardrails</legend>
        <label className="field">
          <span>Never edit pages (one per line)</span>
          <textarea
            rows={2}
            value={listToLines(s.guardrails.neverEditPages)}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  guardrails: {
                    ...s.guardrails,
                    neverEditPages: linesToList(e.target.value)
                  }
                }
              })
            }
          />
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.guardrails.neverModifyMenuAutomatically}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  guardrails: {
                    ...s.guardrails,
                    neverModifyMenuAutomatically: e.target.checked
                  }
                }
              })
            }
          />
          <span>Never modify menu automatically</span>
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={s.guardrails.neverPublishWithoutApproval}
            onChange={(e) =>
              onChange({
                ...value,
                sections: {
                  ...value.sections,
                  guardrails: {
                    ...s.guardrails,
                    neverPublishWithoutApproval: e.target.checked
                  }
                }
              })
            }
          />
          <span>Never publish without approval</span>
        </label>
      </fieldset>
    </div>
  );
}
