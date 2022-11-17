//DO NOT INSTALL THE LATEST VERSION OF AXIOS, STICK TO VERSION 0.27.2
import * as axios from "axios";
import * as fs from "fs";
import * as tmp from "tmp";

/**
 * Called every 5 minutes to collect the results of live matches once they are finished
 * @param s
 * @param flowElement
 * @returns
 */
async function timerFired(s: Switch, flowElement: FlowElement): Promise<void> {
  //set the interval to 5 minutes
  flowElement.setTimerInterval(300);

  //get the properties
  let apiKeyProperty: string = (await flowElement.getPropertyStringValue("APIKey")) as string;
  let leagueName: string = "",
    seasonName: string = "",
    apiKey: string = "";
  if (apiKeyProperty == "Default" || apiKeyProperty == "Automatic") {
    apiKey = "Your Statorium API key";
    leagueName = "FIFA World Cup";
    seasonName = "2022";
  } else {
    apiKey = apiKeyProperty;
    let leagueSeasonName = (await flowElement.getPropertyStringValue("LeagueSeasonName")) as string;
    let leagueSeason = leagueSeasonName.split(" - ");
    if (leagueSeason.length !== 2) {
      //this error could occur when somebody types the league/season combination
      //we use failProcess because this is a timerFired script; otherwise there would just be an error message
      //and the user would not know the flow cannot run without looking at the messages
      flowElement.failProcess("The league/season combination is not correctly defined. They must be separated by ' - '.");
      return;
    }
    leagueName = leagueSeason[0];
    seasonName = leagueSeason[1];
  }

  //initializations
  let leagues: any[], seasons: any[], matchDays: any[], matches: any[], participants: any[];
  let response: Record<string, any>;

  //get the leagues, then the seasons, then the live matches
  try {
    //get the league id
    response = await getStatorium(flowElement, `leagues/?apikey=${apiKey}`);
    leagues = response.leagues;
    let leagueID;
    for (let i = 0; i < leagues.length; i++) {
      if (leagues[i].name == leagueName) {
        leagueID = leagues[i].id;
        break;
      }
    }
    if (leagueID == undefined) {
      flowElement.failProcess(`Could not find the ${leagueName} on Statorium`);
      return;
    }

    //get the season id
    response = await getStatorium(flowElement, `leagues/${leagueID}/?apikey=${apiKey}`);
    seasons = response.league.seasons;
    let seasonID;
    for (let i = 0; i < seasons.length; i++) {
      if (seasons[i].seasonName == seasonName) {
        seasonID = seasons[i].seasonID;
        break;
      }
    }
    if (seasonID == undefined) {
      flowElement.failProcess(`Could not find the ${seasonName} season of ${leagueName} on Statorium`);
      return;
    }

    //get the live matches
    response = await getStatorium(flowElement, `matches/live/?apikey=${apiKey}`);

    //in case there are no live matches, a default set of matches will be retrieved
    //when the API key value was set to "Automatic"
    if (response.matches.length == 0 && apiKeyProperty == "Automatic") {
      seasonID = "40"; //UEFA EURO (Europe) - 2016 final
      response.matches = await getTestMatches(flowElement, apiKey, seasonID);
    }

    //if there are no live matches we can stop here
    if (response.matches.length == 0) {
      await flowElement.log(LogLevel.Debug, "There are currently no live matches");
      return;
    }

    //get the already reported matches from global data
    let reportedMatchesString = await s.getGlobalData(Scope.FlowElement, "ReportedMatches");
    let reportedMatches: Record<string, any>;
    if (reportedMatchesString == "") {
      reportedMatches = {};
    } else {
      reportedMatches = JSON.parse(reportedMatchesString);
    }
    //clean up the reported live matches by removing the ones that are more than 8 hours old
    for (let match in reportedMatches) {
      if (reportedMatches[match].timeStamp < new Date().getTime() - 8 * 60 * 60000) {
        delete reportedMatches[match];
      }
    }

    //loop over the matches and filter the desired ones,
    //based on season id, match is finished and the match has not been reported yet
    let apiCallString: string = "";
    matches = response.matches;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].seasonID == seasonID) {
        if (matches[i].matchStatus.value == "1" || matches[i].matchStatus.statusID == "1") {
          //the matchStatus property is not consistent across different api calls
          //matchStatus.value is for matches listed as a result of the live matches call,\
          //matchStatus.statusID is for matches from the test batch
          //1: match is finished, 0: not started, -1; busy
          apiCallString = `matches/${matches[i].matchID}/?season_id=${seasonID}&apikey=${apiKey}`;
          let matchDetails = await getStatorium(flowElement, apiCallString);
          if (matchDetails.match == undefined) {
            await flowElement.log(LogLevel.Error, `The API call returned no value: ${apiCallString}`);
          } else {
            if (matchDetails.match.matchID == undefined) {
              await flowElement.log(LogLevel.Error, "Error getting the details of the match");
            } else {
              let matchID = matchDetails.match.matchID;
              if (matchID in reportedMatches == true) {
                await flowElement.log(
                  LogLevel.Debug,
                  `The match between ${matchDetails.match.homeParticipant.participantName} and ${matchDetails.match.awayParticipant.participantName} has already been reported`
                );
              } else {
                try {
                  await sendMatch(flowElement, matchDetails);
                  reportedMatches[matchID] = new Date().getTime();
                } catch (error) {
                  await flowElement.log(LogLevel.Error, (error as Error).message);
                }
              }
            }
          }
        }
      }
    }

    //update global data
    await s.setGlobalData(Scope.FlowElement, "ReportedMatches", JSON.stringify(reportedMatches));
  } catch (error) {
    flowElement.failProcess((error as Error).message);
  }
}

/**
 * Function to populate the "Select from library" of the property to choose the league and season combination
 * @param s
 * @param flowElement
 * @param tag
 * @returns
 */
async function getLibraryForProperty(s: Switch, flowElement: FlowElement, tag: string): Promise<string[]> {
  let apiKey: string = (await flowElement.getPropertyStringValue("APIKey")) as string;
  let retval: string[] = [];
  if (tag == "LeagueSeasonName") {
    try {
      //get a list of all available leagues
      let leagueResponse = await getStatorium(flowElement, `leagues/?apikey=${apiKey}`);
      let seasonResponse;
      let leagues = leagueResponse.leagues;
      for (let i = 0; i < leagues.length; i++) {
        //get a list of all the seasons for each league
        seasonResponse = await getStatorium(flowElement, `leagues/${leagues[i].id}/?apikey=${apiKey}`);
        //await flowElement.log(LogLevel.Debug, JSON.stringify(seasonResponse));
        let seasons = seasonResponse.league.seasons;
        for (let j = 0; j < seasons.length; j++) {
          retval.push(`${leagues[i].name} - ${seasons[j].seasonName}`); //concatenate league and season
        }
      }
    } catch (error) {
      await flowElement.log(LogLevel.Error, (error as Error).message);
    }
  }
  return retval;
}

/**
 * Function to send the details of each match as a JSON file with that same file attached as a dataset
 * and 6 pieces of private data with selected information about the match
 * @param flowElement
 * @param matchDetails
 */
async function sendMatch(flowElement: FlowElement, matchDetails: Record<string, any>): Promise<void> {
  let jsonDatasetPath: string = tmp.fileSync().name;

  try {
    let privateDataKey: string = (await flowElement.getPropertyStringValue("PrivateDataKey")) as string;
    let datasetName: string = (await flowElement.getPropertyStringValue("DatasetName")) as string;
    fs.writeFileSync(jsonDatasetPath, JSON.stringify(matchDetails));
    let newJob: Job = await flowElement.createJob(jsonDatasetPath);
    await newJob.createDataset(datasetName, jsonDatasetPath, DatasetModel.JSON);
    let match = matchDetails.match;

    await newJob.setPrivateData(`${privateDataKey}.HomeTeam`, match.homeParticipant.participantName);
    await newJob.setPrivateData(`${privateDataKey}.AwayTeam`, match.awayParticipant.participantName);
    await newJob.setPrivateData(`${privateDataKey}.HomeScore`, match.homeParticipant.score);
    await newJob.setPrivateData(`${privateDataKey}.AwayScore`, match.awayParticipant.score);
    await newJob.setPrivateData(`${privateDataKey}.HomeFlag`, match.homeParticipant.logo);
    await newJob.setPrivateData(`${privateDataKey}.AwayFlag`, match.awayParticipant.logo);
    await newJob.sendToSingle(match.homeParticipant.participantName + "-" + match.awayParticipant.participantName + ".json");
    fs.unlinkSync(jsonDatasetPath);
  } catch (error) {
    fs.unlinkSync(jsonDatasetPath); //just in case the temporary file was created and the error occurred later
    throw error;
  }
}

/**
 * Function to call the Statorium API
 * @param url
 * @returns
 */
async function getStatorium(flowElement: FlowElement, url: string): Promise<Record<string, any>> {
  const StatoriumBaseURL = "https://api.statorium.com/api/v1/";
  await flowElement.log(LogLevel.Debug, StatoriumBaseURL + url);
  try {
    let response = await axios.default.get(StatoriumBaseURL + url);
    return response.data;
  } catch (error) {
    throw error;
  }
}

/**
 * Function that returns a set of matches for testing when there are no live matches
 * @param flowElement
 * @param apiKey
 * @returns
 */
async function getTestMatches(flowElement: FlowElement, apiKey: string, seasonID: string): Promise<Record<string, any>[]> {
  //as part of the API key for the FIFA World Cup 2022 we have access to season id 40 for testing purposes
  //here ALL matches of that league/season are assembled
  await flowElement.log(LogLevel.Debug, "There are currently no live matches, but we are using 'UEFA EURO (Europe) - 2016 final' as a test");
  try {
    let response = await getStatorium(flowElement, `matches/?season_id=${seasonID}&apikey=${apiKey}`);
    response.matches = [];
    let matchDays = response.calendar.matchdays;
    //some tweaking is necessary to make sure the matches contain the seasonID property
    //seasonID is present in the call for live matches, but not in the call that is used here
    for (let i = 0; i < matchDays.length; i++) {
      for (let j = 0; j < matchDays[i].matches.length; j++) {
        matchDays[i].matches[j].seasonID = seasonID;
        response.matches.push(matchDays[i].matches[j]);
      }
    }
    return response.matches;
  } catch (error) {
    throw error;
  }
}
