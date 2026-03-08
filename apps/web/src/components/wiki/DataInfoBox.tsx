import React from "react";
import { InfoBox, type InfoBoxProps } from "./InfoBox";
import { HideableInfoBox } from "./InfoBoxVisibility";
import { getEntityInfoBoxData, getPageById, getExternalLinks } from "@data";

interface DataInfoBoxProps extends Partial<Omit<InfoBoxProps, "type">> {
  entityId?: string;
  type?: string;
}

export async function DataInfoBox({ entityId, type: inlineType, ...inlineProps }: DataInfoBoxProps) {
  if (entityId) {
    const data = getEntityInfoBoxData(entityId);
    if (!data) return <div className="text-muted-foreground text-sm italic">No entity found: {entityId}</div>;

    const pageData = getPageById(entityId);
    const externalLinks = getExternalLinks(entityId);

    const description = pageData?.llmSummary || pageData?.description || undefined;
    const clusters: string[] | undefined = pageData?.clusters?.length ? pageData.clusters : undefined;
    const wordCount: number | undefined = pageData?.wordCount ?? undefined;
    const backlinkCount: number | undefined = pageData?.backlinkCount ?? undefined;

    return (
      <HideableInfoBox>
        <InfoBox
          type={data.type}
          title={data.title}
          severity={data.severity}
          likelihood={data.likelihood}
          timeframe={data.timeframe}
          category={data.category}
          maturity={data.maturity}
          relatedSolutions={data.relatedSolutions}
          website={data.website}
          customFields={data.customFields}
          relatedTopics={data.relatedTopics}
          relatedEntries={data.relatedEntries}
          importance={pageData?.readerImportance ?? undefined}
          tractability={pageData?.tractability ?? undefined}
          neglectedness={pageData?.neglectedness ?? undefined}
          uncertainty={pageData?.uncertainty ?? undefined}
          description={description}
          externalLinks={externalLinks}
          clusters={clusters}
          wordCount={wordCount}
          backlinkCount={backlinkCount}
          // Person fields
          affiliation={data.affiliation}
          role={data.role}
          knownFor={data.knownFor}
          // Organization fields
          founded={data.founded}
          location={data.location}
          headcount={data.headcount}
          funding={data.funding}
          orgType={data.orgType}
          // Policy fields
          introduced={data.introduced}
          policyStatus={data.policyStatus}
          policyAuthor={data.policyAuthor}
          scope={data.scope}
          // Summary page
          summaryPage={data.summaryPage}
          // Overview child pages
          childPages={data.childPages}
          {...inlineProps}
        />
      </HideableInfoBox>
    );
  }

  if (!inlineType) {
    return <div className="text-muted-foreground text-sm italic">InfoBox requires type or entityId</div>;
  }
  return (
    <HideableInfoBox>
      <InfoBox type={inlineType} {...inlineProps} />
    </HideableInfoBox>
  );
}

export default DataInfoBox;
